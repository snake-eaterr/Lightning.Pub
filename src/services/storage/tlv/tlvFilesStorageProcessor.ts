import { PubLogger, getLogger } from '../../helpers/logger.js';
import webRTC, { WebRtcUserInfo } from '../../webRTC/index.js';
import { TlvFilesStorage } from './tlvFilesStorage.js';
import * as Types from '../../../../proto/autogenerated/ts/types.js'
import { SendData } from '../../nostr/handler.js';
import { SendInitiator } from '../../nostr/handler.js';
import { ProcessMetrics, ProcessMetricsCollector } from './processMetricsCollector.js';
import { integerToUint8Array } from '../../helpers/tlv.js';
export type SerializableLatestData = Record<string, Record<string, { base64tlvs: string[], current_chunk: number, available_chunks: number[] }>>
export type SerializableTlvFile = { base64fileData: string, chunks: number[] }
export const usageStorageName = 'usage'
export const bundlerStorageName = 'bundler'
export type TlvStorageSettings = {
    path: string
    name: typeof usageStorageName | typeof bundlerStorageName
}

export type NewTlvStorageOperation = {
    type: 'newStorage'
    opId: string
    settings: TlvStorageSettings
    debug?: boolean
}

export type AddTlvOperation = {
    type: 'addTlv'
    opId: string
    storageName: string
    appId: string
    dataName: string
    base64Tlv: string
    debug?: boolean
}

export type LoadLatestTlvOperation = {
    type: 'loadLatest'
    opId: string
    storageName: string
    limit?: number
    debug?: boolean
}

export type LoadTlvFileOperation = {
    type: 'loadFile'
    opId: string
    storageName: string
    appId: string
    dataName: string
    chunk: number
    debug?: boolean
}

export type WebRtcMessageOperation = {
    type: 'webRtcMessage'
    opId: string
    userInfo: WebRtcUserInfo
    message: Types.WebRtcMessage_message
    debug?: boolean
}

export type ProcessMetricsTlvOperation = {
    type: 'processMetrics'
    opId: string
    processName?: string
    metrics: ProcessMetrics
    debug?: boolean
}

export type ErrorTlvOperationResponse = { success: false, error: string, opId: string }

export interface ITlvStorageOperation {
    opId: string
    type: string
    debug?: boolean
}

export type TlvStorageOperation = NewTlvStorageOperation | AddTlvOperation | LoadLatestTlvOperation | LoadTlvFileOperation | WebRtcMessageOperation | ProcessMetricsTlvOperation

export type SuccessTlvOperationResponse<T> = { success: true, type: string, data: T, opId: string }
export type TlvOperationResponse<T> = SuccessTlvOperationResponse<T> | ErrorTlvOperationResponse

class TlvFilesStorageProcessor {
    private log: PubLogger = console.log
    private storages: Record<string, TlvFilesStorage> = {}
    private wrtc: webRTC
    constructor() {
        if (!process.send) {
            throw new Error('This process must be spawned as a child process');
        }
        process.on('message', (operation: TlvStorageOperation) => {
            this.handleOperation(operation);
        });

        process.on('error', (error: Error) => {
            console.error('Error in storage processor:', error);
        });

        this.wrtc = new webRTC(t => {
            switch (t) {
                case Types.SingleMetricType.USAGE_METRIC:
                    return this.storages[usageStorageName]
                case Types.SingleMetricType.BUNDLE_METRIC:
                    return this.storages[bundlerStorageName]
                default:
                    throw new Error('Unknown metric type: ' + t)
            }
        })
        this.wrtc.attachNostrSend((initiator: SendInitiator, data: SendData, relays?: string[] | undefined) => {
            this.sendResponse({
                success: true,
                type: 'nostrSend',
                data: { initiator, data, relays },
                opId: Math.random().toString()
            });
        })
        new ProcessMetricsCollector((pMetrics) => {
            this.saveProcessMetrics(pMetrics, 'tlv_processor')
        })
    }

    private serializeNowTlv = (v: number) => {
        const nowUnix = Math.floor(Date.now() / 1000)
        const entry = new Uint8Array(8)
        entry.set(integerToUint8Array(nowUnix), 0)
        entry.set(integerToUint8Array(v), 4)
        return entry
    }

    private saveProcessMetrics = (pMetrics: ProcessMetrics, processName = "") => {
        const pName = processName ? '_' + processName : ''
        if (!this.storages[bundlerStorageName]) {
            console.log('no bundle storage yet')
            return
        }
        if (pMetrics.memory_rss_kb) this.storages[bundlerStorageName].AddTlv('_root', 'memory_rss_kb' + pName, this.serializeNowTlv(pMetrics.memory_rss_kb))
        if (pMetrics.memory_buffer_kb) this.storages[bundlerStorageName].AddTlv('_root', 'memory_buffer_kb' + pName, this.serializeNowTlv(pMetrics.memory_buffer_kb))
        if (pMetrics.memory_heap_total_kb) this.storages[bundlerStorageName].AddTlv('_root', 'memory_heap_total_kb' + pName, this.serializeNowTlv(pMetrics.memory_heap_total_kb))
        if (pMetrics.memory_heap_used_kb) this.storages[bundlerStorageName].AddTlv('_root', 'memory_heap_used_kb' + pName, this.serializeNowTlv(pMetrics.memory_heap_used_kb))
        if (pMetrics.memory_external_kb) this.storages[bundlerStorageName].AddTlv('_root', 'memory_external_kb' + pName, this.serializeNowTlv(pMetrics.memory_external_kb))
    }

    private async handleOperation(operation: TlvStorageOperation) {
        try {
            const opId = operation.opId;
            if (operation.debug) console.log('handleOperation', operation)
            switch (operation.type) {
                case 'newStorage':
                    await this.handleNewStorage(operation);
                    break;
                case 'addTlv':
                    await this.handleAddTlv(operation);
                    break;
                case 'loadLatest':
                    await this.handleLoadLatestTlv(operation);
                    break;
                case 'loadFile':
                    await this.handleLoadTlvFile(operation);
                    break;
                case 'webRtcMessage':
                    await this.handleWebRtcMessage(operation);
                    break;
                case 'processMetrics':
                    await this.handleProcessMetrics(operation);
                    break;
                default:
                    this.sendResponse({
                        success: false,
                        error: `Unknown operation type: ${(operation as any).type}`,
                        opId
                    })
                    return
            }
        } catch (error) {
            this.sendResponse({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred',
                opId: operation.opId
            });
        }
    }

    private async handleNewStorage(operation: NewTlvStorageOperation) {
        if (this.storages[operation.settings.name]) {
            this.sendResponse({
                success: false,
                error: `Storage ${operation.settings.name} already exists`,
                opId: operation.opId
            })
            return
        }
        this.storages[operation.settings.name] = new TlvFilesStorage(operation.settings.path)
        this.sendResponse({
            success: true,
            type: 'newStorage',
            data: null,
            opId: operation.opId
        });
    }

    private async handleAddTlv(operation: AddTlvOperation) {
        if (!this.storages[operation.storageName]) {
            this.sendResponse({
                success: false,
                error: `Storage ${operation.storageName} does not exist`,
                opId: operation.opId
            })
            return
        }
        const tlv = new Uint8Array(Buffer.from(operation.base64Tlv, 'base64'))
        this.storages[operation.storageName].AddTlv(operation.appId, operation.dataName, tlv)
        this.sendResponse<null>({
            success: true,
            type: 'addTlv',
            data: null,
            opId: operation.opId
        });
    }

    private async handleLoadLatestTlv(operation: LoadLatestTlvOperation) {
        if (!this.storages[operation.storageName]) {
            this.sendResponse({
                success: false,
                error: `Storage ${operation.storageName} does not exist`,
                opId: operation.opId
            })
            return
        }
        const data = this.storages[operation.storageName].LoadLatest(operation.limit)
        const serializableData: SerializableLatestData = {}
        for (const appId in data) {
            serializableData[appId] = {}
            for (const dataName in data[appId]) {
                serializableData[appId][dataName] = { base64tlvs: data[appId][dataName].tlvs.map(tlv => Buffer.from(tlv).toString('base64')), current_chunk: data[appId][dataName].current_chunk, available_chunks: data[appId][dataName].available_chunks }
            }
        }
        this.sendResponse<SerializableLatestData>({
            success: true,
            type: 'loadLatest',
            data: serializableData,
            opId: operation.opId
        });
    }

    private async handleLoadTlvFile(operation: LoadTlvFileOperation) {
        if (!this.storages[operation.storageName]) {
            this.sendResponse({
                success: false,
                error: `Storage ${operation.storageName} does not exist`,
                opId: operation.opId
            })
            return
        }
        const data = this.storages[operation.storageName].LoadFile(operation.appId, operation.dataName, operation.chunk)
        this.sendResponse<SerializableTlvFile>({
            success: true,
            type: 'loadFile',
            data: { base64fileData: Buffer.from(data.fileData).toString('base64'), chunks: data.chunks },
            opId: operation.opId
        });
    }

    private async handleWebRtcMessage(operation: WebRtcMessageOperation) {
        const answer = await this.wrtc.OnMessage(operation.userInfo, operation.message)
        this.sendResponse<Types.WebRtcAnswer>({
            success: true,
            type: 'webRtcMessage',
            data: answer,
            opId: operation.opId
        });
    }

    private async handleProcessMetrics(operation: ProcessMetricsTlvOperation) {
        this.saveProcessMetrics(operation.metrics, operation.processName)
        this.sendResponse<null>({
            success: true,
            type: 'processMetrics',
            data: null,
            opId: operation.opId
        });
    }

    private sendResponse<T>(response: TlvOperationResponse<T>) {
        if (process.send) {
            process.send(response);
        }
    }
}

// Start the storage processor
new TlvFilesStorageProcessor();
