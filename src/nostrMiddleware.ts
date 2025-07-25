import Main from "./services/main/index.js"
import Nostr from "./services/nostr/index.js"
import { NostrEvent, NostrSend, NostrSettings } from "./services/nostr/handler.js"
import * as Types from '../proto/autogenerated/ts/types.js'
import NewNostrTransport, { NostrRequest } from '../proto/autogenerated/ts/nostr_transport.js';
import { ERROR, getLogger } from "./services/helpers/logger.js";
import { NdebitData, NofferData, NmanageRequest } from "@shocknet/clink-sdk";

export default (serverMethods: Types.ServerMethods, mainHandler: Main, nostrSettings: NostrSettings, onClientEvent: (e: { requestId: string }, fromPub: string) => void): { Stop: () => void, Send: NostrSend, Ping: () => Promise<void> } => {
    const log = getLogger({})
    const nostrTransport = NewNostrTransport(serverMethods, {
        NostrUserAuthGuard: async (appId, pub) => {
            const app = await mainHandler.storage.applicationStorage.GetApplication(appId || "")
            const nostrUser = await mainHandler.storage.applicationStorage.GetOrCreateNostrAppUser(app, pub || "")
            return { user_id: nostrUser.user.user_id, app_user_id: nostrUser.identifier, app_id: appId || "" }
        },
        NostrAdminAuthGuard: async (appId, pub) => {
            const adminNpub = mainHandler.adminManager.GetAdminNpub()
            if (!adminNpub) { throw new Error("admin access not configured") }
            if (pub !== adminNpub) { throw new Error("admin access denied") }
            log("admin access from", pub)
            return { admin_id: pub }
        },
        NostrMetricsAuthGuard: async (appId, pub) => {
            const adminNpub = mainHandler.adminManager.GetAdminNpub()
            if (!adminNpub) { throw new Error("admin access not configured") }
            if (pub !== adminNpub) { throw new Error("Metrics unavailable") }
            log("operator access from", pub)
            return { operator_id: pub, app_id: appId || "" }
        },
        metricsCallback: metrics => mainHandler.settings.recordPerformance ? mainHandler.metricsManager.AddMetrics(metrics) : null,
        NostrGuestWithPubAuthGuard: async (appId, pub) => {
            if (!pub || !appId) {
                throw new Error("Unknown error occured")
            }
            return { pub, app_id: appId }
        },
        logger: { log: console.log, error: err => log(ERROR, err) },
    })

    const nostr = new Nostr(nostrSettings, mainHandler.utils, event => {
        let j: NostrRequest
        try {
            j = JSON.parse(event.content)
            //log("nostr event", j.rpcName || 'no rpc name') 
        } catch {
            log(ERROR, "invalid json event received", event.content)
            return
        }
        if (event.kind === 21001) {
            const offerReq = j as NofferData
            mainHandler.offerManager.handleNip69Noffer(offerReq, event)
            return
        } else if (event.kind === 21002) {
            const debitReq = j as NdebitData
            mainHandler.debitManager.handleNip68Debit(debitReq, event)
            return
        } else if (event.kind === 21003) {
            const nmanageReq = j as NmanageRequest
            mainHandler.managementManager.handleRequest(nmanageReq, event);
            return;
        }
        if (!j.rpcName) {
            onClientEvent(j as { requestId: string }, event.pub)
            return
        }
        if (j.authIdentifier !== event.pub) {
            log(ERROR, "authIdentifier does not match", j.authIdentifier || "--", event.pub)
            return
        }
        nostrTransport({ ...j, appId: event.appId }, res => {
            nostr.Send({ type: 'app', appId: event.appId }, { type: 'content', pub: event.pub, content: JSON.stringify({ ...res, requestId: j.requestId }) })
        }, event.startAtNano, event.startAtMs)
    })

    return { Stop: () => nostr.Stop, Send: (...args) => nostr.Send(...args), Ping: () => nostr.Ping() }
}


