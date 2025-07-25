import { getRepository } from "typeorm";
import { User } from "../storage/entity/User.js";
import { UserOffer } from "../storage/entity/UserOffer.js";
import { ManagementGrant } from "../storage/entity/ManagementGrant.js";
import { NostrEvent, NostrSend } from "../nostr/handler.js";
import Storage from "../storage/index.js";
import { OfferManager } from "./offerManager.js";
import * as Types from "../../../proto/autogenerated/ts/types.js";
import { MainSettings } from "./settings.js";
import { nofferEncode, OfferPointer, OfferPriceType, NmanageRequest, NmanageResponse, NmanageCreateOffer, NmanageUpdateOffer, NmanageDeleteOffer, NmanageGetOffer, NmanageListOffers, OfferData, OfferFields, NmanageFailure } from "@shocknet/clink-sdk";
import { UnsignedEvent } from "nostr-tools";
import { getLogger, PubLogger, ERROR } from "../helpers/logger.js";
type Result<T> = { state: 'success', result: T } | { state: 'error', err: NmanageFailure } | { state: 'authRequired' }

export class ManagementManager {
    private nostrSend: NostrSend;
    private storage: Storage;
    private settings: MainSettings;
    private awaitingRequests: Record<string, { request: NmanageRequest, event: NostrEvent }> = {}
    private logger: PubLogger
    constructor(storage: Storage, settings: MainSettings) {
        this.storage = storage;
        this.settings = settings;
        this.logger = getLogger({ component: 'ManagementManager' })
    }

    attachNostrSend(f: NostrSend) {
        this.nostrSend = f
    }

    ResetManage = async (ctx: Types.UserContext, req: Types.ManageOperation): Promise<void> => {
        await this.storage.managementStorage.removeGrant(ctx.app_user_id, req.npub)
    }

    AuthorizeManage = async (ctx: Types.UserContext, req: Types.ManageAuthorizationRequest): Promise<Types.ManageAuthorization> => {
        const grant = await this.storage.managementStorage.addGrant(ctx.app_user_id, req.authorize_npub, req.ban)
        const awaiting = this.awaitingRequests[req.authorize_npub]
        if (awaiting) {
            delete this.awaitingRequests[req.authorize_npub]
            if (!grant.banned) {
                await this.handleRequest(awaiting.request, awaiting.event)
            }
        }
        return {
            manage_id: grant.serial_id.toString(),
            authorized: !grant.banned,
            npub: grant.app_pubkey,
        }
    }

    GetManageAuthorizations = async (ctx: Types.UserContext): Promise<Types.ManageAuthorizations> => {
        const grants = await this.storage.managementStorage.getGrants(ctx.app_user_id)
        return {
            manages: grants.map(grant => ({
                manage_id: grant.serial_id.toString(),
                authorized: !grant.banned,
                npub: grant.app_pubkey,
            }))
        }
    }

    private sendManageAuthorizationRequest = (appId: string, userPub: string, { requestId, npub }: { requestId: string, npub: string }) => {
        const message: Types.LiveManageRequest & { requestId: string, status: 'OK' } = { requestId: "GetLiveManageRequests", status: 'OK', npub: npub, request_id: requestId }
        this.logger("Sending manage authorization request to", npub, "for app", appId)
        this.nostrSend({ type: 'app', appId: appId }, { type: 'content', content: JSON.stringify(message), pub: userPub })
    }

    private sendError(event: NostrEvent, err: NmanageFailure) {
        const e = newNmanageResponse(JSON.stringify(err), event)
        this.nostrSend({ type: 'app', appId: event.appId }, { type: 'event', event: e, encrypt: { toPub: event.pub } })
    }

    private async handleAuthRequired(nmanageReq: NmanageRequest, event: NostrEvent) {
        if (this.awaitingRequests[event.pub]) {
            this.sendError(event, { res: 'GFY', code: 4, error: 'Rate Limited', retry_after: 60 * 10 })
            return
        }
        const appUserId = (nmanageReq as { pointer?: string }).pointer
        if (!appUserId) {
            this.logger(ERROR, "No pointer provided", event.pub)
            this.sendError(event, { res: 'GFY', code: 1, error: 'Request Denied: No pointer provided, cannot sent auth request' })
            return
        }
        const app = await this.storage.applicationStorage.GetApplication(event.appId)
        const appUser = await this.storage.applicationStorage.GetApplicationUser(app, appUserId)
        if (!appUser.nostr_public_key) {
            this.logger(ERROR, "App user has no nostr public key", event.pub)
            this.sendError(event, { res: 'GFY', code: 1, error: 'Request Denied: App user has no nostr public key' })
            return
        }
        this.awaitingRequests[event.pub] = { request: nmanageReq, event }
        this.sendManageAuthorizationRequest(event.appId, appUser.nostr_public_key, { requestId: event.id, npub: event.pub })
    }



    async handleRequest(nmanageReq: NmanageRequest, event: NostrEvent): Promise<void> {
        try {
            const r = await this.doNmanage(nmanageReq, event)
            if (r.state === 'authRequired') {
                await this.handleAuthRequired(nmanageReq, event)
                return
            }
            if (r.state === 'error') {
                this.logger(ERROR, "Error in nmanage request", r.err)
                this.sendError(event, r.err)
                return
            }
            const e = newNmanageResponse(JSON.stringify(r.result), event)
            this.nostrSend({ type: 'app', appId: event.appId }, { type: 'event', event: e, encrypt: { toPub: event.pub } })
        } catch (err: any) {
            this.logger(ERROR, err.message || err)
            this.sendError(event, { res: 'GFY', code: 2, error: 'Temporary Failure' })
        }
    }

    private async doNmanage(nmanageReq: NmanageRequest, event: NostrEvent): Promise<Result<NmanageResponse>> {
        const action = nmanageReq.action
        switch (action) {
            case "create":
                const createResult = await this.createOffer(nmanageReq, event.pub)
                return this.getNmanageResponse(event.appId, createResult)
            case "update":
                const updateResult = await this.updateOffer(nmanageReq, event.pub);
                return this.getNmanageResponse(event.appId, updateResult)
            case "delete":
                const deleteResult = await this.deleteOffer(nmanageReq, event.pub);
                return this.getNmanageResponse(event.appId, deleteResult)
            case "get":
                const getResult = await this.getOffer(nmanageReq, event.pub);
                return this.getNmanageResponse(event.appId, getResult)
            case "list":
                const listResult = await this.listOffers(nmanageReq, event.pub);
                return this.getNmanageResponse(event.appId, listResult)
            default:
                return { state: 'error', err: { res: 'GFY', code: 1, error: `Request Denied: Unknown action: ${action}` } }
        }
    }

    private getOfferData(offer: UserOffer, appPub: string): OfferData {
        const pointer: OfferPointer = {
            offer: offer.offer_id,
            pubkey: appPub,
            relay: this.settings.nostrRelaySettings.relays[0],
            priceType: offer.price_sats > 0 ? OfferPriceType.Fixed : OfferPriceType.Spontaneous,
            price: offer.price_sats,
        }
        return {
            id: offer.offer_id,
            label: offer.label,
            price_sats: offer.price_sats,
            callback_url: offer.callback_url,
            payer_data: offer.payer_data || [],
            noffer: nofferEncode(pointer),
        }
    }

    private async getNmanageResponse(appId: string, result: Result<UserOffer | UserOffer[] | void>): Promise<Result<NmanageResponse>> {
        if (result.state !== 'success') {
            return result
        }
        const args = result.result
        const app = await this.storage.applicationStorage.GetApplication(appId)
        if (args && Array.isArray(args)) {
            return {
                state: 'success', result: {
                    res: 'ok', resource: 'offer', details: args.map(offer => this.getOfferData(offer, app.nostr_public_key!))
                }
            }
        }
        if (!args) {
            return { state: 'success', result: { res: 'ok', resource: 'offer' } }
        }
        return {
            state: 'success', result: {
                res: 'ok', resource: 'offer', details: this.getOfferData(args, app.nostr_public_key!)
            }
        }
    }

    private async getOffer(nmanageReq: NmanageGetOffer, requestorPub: string): Promise<Result<UserOffer>> {
        const offer = await this.validateOfferAccess(nmanageReq.offer.id, requestorPub)
        if (offer.state !== 'success') {
            return offer
        }
        return { state: 'success', result: offer.result }
    }

    private async listOffers(nmanageReq: NmanageListOffers, requestorPub: string): Promise<Result<UserOffer[]>> {
        const appUserId = nmanageReq.pointer
        if (!appUserId) {
            return { state: 'error', err: { res: 'GFY', code: 1, error: 'Request Denied: No pointer provided' } }
        }
        const grantResult = await this.validateGrantAccess(appUserId, requestorPub)
        if (grantResult.state !== 'success') {
            return grantResult
        }
        const offers = await this.storage.offerStorage.getManagedUserOffers(appUserId, requestorPub)
        return { state: 'success', result: offers }
    }

    private validateOfferFields(fields: OfferFields): Result<void> {
        if (!fields.label || typeof fields.label !== 'string') {
            return { state: 'error', err: { res: 'GFY', code: 5, error: 'Invalid Field/Value', field: 'label' } }
        }
        if (fields.price_sats && typeof fields.price_sats !== 'number') {
            return { state: 'error', err: { res: 'GFY', code: 5, error: 'Invalid Field/Value', field: 'price_sats' } }
        }
        if (fields.callback_url && typeof fields.callback_url !== 'string') {
            return { state: 'error', err: { res: 'GFY', code: 5, error: 'Invalid Field/Value', field: 'callback_url' } }
        }
        if (fields.payer_data && !Array.isArray(fields.payer_data)) {
            return { state: 'error', err: { res: 'GFY', code: 5, error: 'Invalid Field/Value', field: 'payer_data' } }
        }

        return { state: 'success', result: undefined }
    }

    private async createOffer(nmanageReq: NmanageCreateOffer, requestorPub: string): Promise<Result<UserOffer>> {
        const appUserId = nmanageReq.pointer
        if (!appUserId) {
            return { state: 'error', err: { res: 'GFY', code: 1, error: 'Request Denied: No pointer provided' } }
        }
        const grantResult = await this.validateGrantAccess(appUserId, requestorPub)
        if (grantResult.state !== 'success') {
            return grantResult
        }
        const validateResult = this.validateOfferFields(nmanageReq.offer.fields)
        if (validateResult.state !== 'success') {
            return validateResult
        }
        const offer = await this.storage.offerStorage.AddUserOffer(appUserId, {
            label: nmanageReq.offer.fields.label,
            callback_url: nmanageReq.offer.fields.callback_url,
            price_sats: nmanageReq.offer.fields.price_sats,
            payer_data: nmanageReq.offer.fields.payer_data,
            management_pubkey: requestorPub,
        })
        return { state: 'success', result: offer }
    }

    private async validateGrantAccess(appUserId: string, requestorPub: string): Promise<Result<void>> {
        const grant = await this.storage.managementStorage.getGrant(appUserId, requestorPub)

        if (!grant) {
            this.logger(ERROR, "No grant found", appUserId, requestorPub)
            return { state: 'authRequired' }
        }

        if (grant.expires_at_unix > 0 && grant.expires_at_unix < Date.now()) {
            this.logger(ERROR, "Grant expired", appUserId, requestorPub)
            return { state: 'authRequired' }
        }

        if (grant.banned) {
            return { state: 'error', err: { res: 'GFY', code: 1, error: 'Request Denied: App is banned' } }
        }


        return { state: 'success', result: undefined }
    }

    private async validateOfferAccess(offerId: string, requestorPub: string): Promise<Result<UserOffer>> {
        const offer = await this.storage.offerStorage.GetOffer(offerId)
        if (!offer) {
            return { state: 'error', err: { res: 'GFY', code: 1, error: 'Request Denied: Offer not found' } }
        }
        if (offer.management_pubkey !== requestorPub) {
            return { state: 'error', err: { res: 'GFY', code: 1, error: 'Request Denied: App not authorized to update offer' } }
        }
        const grantResult = await this.validateGrantAccess(offer.app_user_id, requestorPub)
        if (grantResult.state !== 'success') {
            return grantResult
        }
        return { state: 'success', result: offer }
    }

    private async updateOffer(nmanageReq: NmanageUpdateOffer, requestorPub: string): Promise<Result<UserOffer>> {
        const offer = await this.validateOfferAccess(nmanageReq.offer.id, requestorPub)
        if (offer.state !== 'success') {
            return offer
        }
        const validateResult = this.validateOfferFields(nmanageReq.offer.fields)
        if (validateResult.state !== 'success') {
            return validateResult
        }
        for (const data of nmanageReq.offer.fields.payer_data || []) {
            if (typeof data !== 'string') {
                return { state: 'error', err: { res: 'GFY', code: 5, error: 'Invalid Field/Value', field: 'payer_data' } }
            }
        }
        await this.storage.offerStorage.UpdateUserOffer(offer.result.app_user_id, nmanageReq.offer.id, {
            label: nmanageReq.offer.fields.label,
            callback_url: nmanageReq.offer.fields.callback_url,
            price_sats: nmanageReq.offer.fields.price_sats,
            payer_data: nmanageReq.offer.fields.payer_data,
        })
        const updatedOffer = await this.storage.offerStorage.GetOffer(nmanageReq.offer.id)
        if (!updatedOffer) {
            return { state: 'error', err: { res: 'GFY', code: 2, error: 'Temporary Failure: Offer not found' } }
        }
        return { state: 'success', result: updatedOffer }
    }

    private async deleteOffer(nmanageReq: NmanageDeleteOffer, requestorPub: string): Promise<Result<void>> {
        const offerResult = await this.validateOfferAccess(nmanageReq.offer.id, requestorPub)
        if (offerResult.state !== 'success') {
            return offerResult
        }
        await this.storage.offerStorage.DeleteUserOffer(offerResult.result.app_user_id, offerResult.result.offer_id)
        return { state: 'success', result: undefined }
    }
}

const newNmanageResponse = (content: string, event: NostrEvent): UnsignedEvent => {
    return {
        content,
        created_at: Math.floor(Date.now() / 1000),
        kind: 21003,
        pubkey: "",
        tags: [
            ['p', event.pub],
            ['e', event.id],
        ],
    }
}
const codeToMessage = (code: number, reason = "") => {
    switch (code) {
        case 1: return 'Request Denied'
        case 2: return 'Temporary Failure: ' + reason
        case 3: return 'Expired Request'
        case 4: return 'Rate Limited'
        case 5: return 'Invalid Field or Value'
        case 6: return 'Invalid Request: ' + reason
        default: throw new Error("unknown error code" + code)
    }
}