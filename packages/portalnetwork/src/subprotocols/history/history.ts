import { fromHexString, toHexString } from '@chainsafe/ssz'
import { ENR } from '@chainsafe/discv5/index.js'
import { Block, BlockHeader } from '@ethereumjs/block'
import { Debugger } from 'debug'
import { ProtocolId } from '../types.js'
import { PortalNetwork } from '../../client/client.js'
import { PortalNetworkMetrics } from '../../client/types.js'
import { shortId } from '../../util/index.js'
import { HeaderAccumulator } from './headerAccumulator.js'
import {
  connectionIdType,
  ContentMessageType,
  FindContentMessage,
  MessageCodes,
  PortalWireMessageType,
} from '../../wire/index.js'
import { RequestCode } from '../../wire/utp/PortalNetworkUtp/PortalNetworkUTP.js'
import { ContentLookup } from '../contentLookup.js'
import { BaseProtocol } from '../protocol.js'
import {
  HistoryNetworkContentTypes,
  HistoryNetworkContentKeyUnionType,
  HeaderAccumulatorType,
  HistoryNetworkContentKey,
  EPOCH_SIZE,
  EpochAccumulator,
} from './types.js'
import { getHistoryNetworkContentId, reassembleBlock } from './util.js'
import * as rlp from 'rlp'
import { ReceiptsManager } from './receiptManager.js'

export class HistoryProtocol extends BaseProtocol {
  protocolId: ProtocolId
  protocolName: string
  accumulator: HeaderAccumulator
  logger: Debugger
  gossipQueue: [string, HistoryNetworkContentTypes][]
  public receiptManager: ReceiptsManager
  constructor(client: PortalNetwork, nodeRadius?: bigint, metrics?: PortalNetworkMetrics) {
    super(client, undefined, metrics)
    this.protocolId = ProtocolId.HistoryNetwork
    this.protocolName = 'History Network'
    this.logger = client.logger.extend('HistoryNetwork')
    this.accumulator = new HeaderAccumulator({})
    this.gossipQueue = []
    this.receiptManager = new ReceiptsManager(this.client.db, this)
  }

  public init = async () => {
    this.client.uTP.on('Stream', async (chainId, selector, blockHash, content) => {
      if (selector === HistoryNetworkContentTypes.EpochAccumulator) {
        blockHash = toHexString(
          EpochAccumulator.hashTreeRoot(EpochAccumulator.deserialize(content))
        )
      }
      await this.addContentToHistory(chainId, selector, blockHash, content)
    })

    let storedAccumulator
    try {
      storedAccumulator = await this.client.db.get(
        getHistoryNetworkContentId(1, HistoryNetworkContentTypes.HeaderAccumulator)
      )
    } catch {}

    if (storedAccumulator) {
      const accumulator = HeaderAccumulatorType.deserialize(fromHexString(storedAccumulator))
      this.accumulator = new HeaderAccumulator({
        storedAccumulator: {
          historicalEpochs: accumulator.historicalEpochs,
          currentEpoch: accumulator.currentEpoch,
        },
      })
    } else {
      this.accumulator = new HeaderAccumulator({ initFromGenesis: true })
    }
  }

  /**
   * Send FINDCONTENT request for content corresponding to `key` to peer corresponding to `dstId`
   * @param dstId node id of peer
   * @param key content key defined by the subprotocol spec
   * @param protocolId subprotocol ID on which content is being sought
   * @returns the value of the FOUNDCONTENT response or undefined
   */
  public sendFindContent = async (dstId: string, key: Uint8Array) => {
    this.metrics?.findContentMessagesSent.inc()
    const findContentMsg: FindContentMessage = { contentKey: key }
    const payload = PortalWireMessageType.serialize({
      selector: MessageCodes.FINDCONTENT,
      value: findContentMsg,
    })
    const enr = this.routingTable.getValue(dstId)
    if (!enr) {
      this.logger(`No ENR found for ${shortId(dstId)}.  FINDCONTENT aborted.`)
      return
    }
    this.logger.extend('FINDCONTENT')(`Sending to ${shortId(dstId)}`)
    const res = await this.client.sendPortalNetworkMessage(
      enr,
      Buffer.from(payload),
      this.protocolId
    )

    try {
      if (parseInt(res.slice(0, 1).toString('hex')) === MessageCodes.CONTENT) {
        this.metrics?.contentMessagesReceived.inc()
        this.logger.extend('FOUNDCONTENT')(`Received from ${shortId(dstId)}`)
        // TODO: Switch this to use PortalWireMessageType.deserialize if type inference can be worked out
        const decoded = ContentMessageType.deserialize(res.subarray(1))
        const decodedKey = HistoryNetworkContentKeyUnionType.deserialize(key)
        switch (decoded.selector) {
          case 0: {
            const id = connectionIdType.deserialize(decoded.value as Uint8Array)
            this.logger.extend('FOUNDCONTENT')(`received uTP Connection ID ${id}`)
            await this.client.uTP.handleNewRequest({
              contentKeys: [key],
              peerId: dstId,
              connectionId: id,
              requestCode: RequestCode.FINDCONTENT_READ,
              contents: [],
            })
            break
          }
          case 1:
            {
              // Store content in local DB
              switch (decodedKey.selector) {
                case HistoryNetworkContentTypes.BlockHeader:
                case HistoryNetworkContentTypes.BlockBody:
                case HistoryNetworkContentTypes.Receipt:
                case HistoryNetworkContentTypes.EpochAccumulator:
                  {
                    const content = decodedKey.value as HistoryNetworkContentKey
                    this.logger(`received content corresponding to ${content!.blockHash}`)
                    try {
                      this.addContentToHistory(
                        content.chainId,
                        decodedKey.selector,
                        toHexString(Buffer.from(content.blockHash!)),
                        decoded.value as Uint8Array
                      )
                    } catch {
                      this.logger('Error adding content to DB')
                    }
                  }
                  break
                case HistoryNetworkContentTypes.HeaderAccumulator: {
                  this.addContentToHistory(
                    1,
                    decodedKey.selector,
                    getHistoryNetworkContentId(1, 4),
                    decoded.value as Uint8Array
                  )
                }
              }
            }
            break
          case 2: {
            this.logger(`received ${decoded.value.length} ENRs`)
            break
          }
        }
        return decoded
      }
    } catch (err: any) {
      this.logger(`Error sending FINDCONTENT to ${shortId(dstId)} - ${err.message}`)
    }
  }

  private receiveSnapshot = (decoded: Uint8Array) => {
    try {
      const receivedAccumulator = HeaderAccumulatorType.deserialize(decoded)
      const newAccumulator = new HeaderAccumulator({
        initFromGenesis: false,
        storedAccumulator: {
          historicalEpochs: receivedAccumulator.historicalEpochs,
          currentEpoch: receivedAccumulator.currentEpoch,
        },
      })
      this.logger(
        `Received an accumulator snapshot with ${receivedAccumulator.currentEpoch.length} headers in the current epoch`
      )
      if (this.accumulator.currentHeight() < newAccumulator.currentHeight()) {
        // If we don't have an accumulator, adopt the snapshot received
        // TODO: Decide how to verify if this snapshot is trustworthy
        this.logger(
          'Replacing Accumulator of height',
          this.accumulator.currentHeight(),
          'with Accumulator of height',
          newAccumulator.currentHeight()
        )
        this.accumulator = newAccumulator
        this.client.db.put(getHistoryNetworkContentId(1, 4), toHexString(decoded))

        /*    const historicalEpochs = this.accumulator.historicalEpochs
        historicalEpochs.forEach(async (epochHash, idx) => {
          this.logger(`looking up ${toHexString(epochHash)} hash`)
          const lookupKey = HistoryNetworkContentKeyUnionType.serialize({
            selector: HistoryNetworkContentTypes.EpochAccumulator,
            value: { chainId: 1, blockHash: epochHash },
          })
          const lookup = new ContentLookup(this, lookupKey)
          const epoch = await lookup.startLookup()
          if (epoch) {
            this.logger(
              `Storing EpochAccumulator for Blocks ${idx * EPOCH_SIZE} - ${
                idx * EPOCH_SIZE + EPOCH_SIZE - 1
              }`
            )
          }
        })*/
      }
    } catch (err: any) {
      this.logger(`Error parsing accumulator snapshot: ${err.message}`)
    }
  }

  public getBlockByHash = async (
    blockHash: string,
    includeTransactions: boolean
  ): Promise<Block | undefined> => {
    const headerContentKey = HistoryNetworkContentKeyUnionType.serialize({
      selector: 0,
      value: { chainId: 1, blockHash: fromHexString(blockHash) },
    })

    const bodyContentKey = includeTransactions
      ? HistoryNetworkContentKeyUnionType.serialize({
          selector: 1,
          value: { chainId: 1, blockHash: fromHexString(blockHash) },
        })
      : undefined
    let header: any
    let body: any
    let block
    try {
      let lookup = new ContentLookup(this, headerContentKey)
      header = await lookup.startLookup()
      if (!header) {
        return undefined
      }
      if (!includeTransactions) {
        block = reassembleBlock(header, rlp.encode([[], []]))
        return block
      } else {
        lookup = new ContentLookup(this, bodyContentKey!)
        body = await lookup.startLookup()
        return new Promise((resolve) => {
          if (body) {
            // Try assembling block
            try {
              block = reassembleBlock(header, body)
              resolve(block)
            } catch {}
          }
          block = reassembleBlock(header, body)
          resolve(block)
        })
      }
    } catch {}
  }

  public getBlockByNumber = async (
    blockNumber: number,
    includeTransactions: boolean
  ): Promise<Block | undefined> => {
    if (blockNumber > this.accumulator.currentHeight()) {
      this.logger(`Block number ${blockNumber} is higher than current known chain height`)
      return
    }
    let blockHash
    const blockIndex = blockNumber % EPOCH_SIZE
    if (blockNumber > 8192 * this.accumulator.historicalEpochs.length) {
      blockHash = toHexString(this.accumulator.currentEpoch[blockIndex].blockHash)
      this.logger(`Blockhash found for BlockNumber ${blockNumber}: ${blockHash}`)
      try {
        const block = await this.getBlockByHash(blockHash, includeTransactions)
        return block
      } catch (err) {
        this.logger(`getBlockByNumber error: ${(err as any).message}`)
      }
    } else {
      const historicalEpochIndex = Math.floor(blockNumber / EPOCH_SIZE)
      const epochRootHash = this.accumulator.historicalEpochs[historicalEpochIndex]
      if (!epochRootHash) {
        this.logger('Error with epoch root lookup')
        return
      }
      const lookupKey = HistoryNetworkContentKeyUnionType.serialize({
        selector: 3,
        value: { chainId: 1, blockHash: epochRootHash },
      })

      const lookup = new ContentLookup(this, lookupKey)
      const result = await lookup.startLookup()
      if (result === undefined || !(result instanceof Uint8Array)) {
        this.logger('eth_getBlockByNumber failed to retrieve historical epoch accumulator')
        return undefined
      }

      try {
        const epoch = EpochAccumulator.deserialize(result)
        this.logger.extend(`ETH_GETBLOCKBYNUMBER`)(
          `Found EpochAccumulator with blockHash for block ${blockNumber}`
        )
        blockHash = toHexString(epoch[blockIndex].blockHash)

        const block = await this.getBlockByHash(blockHash, includeTransactions)
        if (block?.header.number === BigInt(blockNumber)) {
          return block
        } else if (block !== undefined) {
          this.logger(`eth_getBlockByNumber returned the wrong block, ${block?.header.number}`)
          return
        } else {
          this.logger(`eth_getBlockByNumber failed to find block`)
        }
      } catch (err: any) {
        this.logger(`eth_getBlockByNumber encountered an error: ${err.message}`)
      }
    }
  }
  /**
   * Convenience method to add content for the History Network to the DB
   * @param chainId - decimal number representing chain Id
   * @param contentType - content type of the data item being stored
   * @param hashKey - hex string representation of blockHash or epochHash
   * @param value - hex string representing RLP encoded blockheader, block body, or block receipt
   * @throws if `blockHash` or `value` is not hex string
   */
  public addContentToHistory = async (
    chainId: number,
    contentType: HistoryNetworkContentTypes,
    hashKey: string,
    value: Uint8Array
  ) => {
    const contentId = getHistoryNetworkContentId(chainId, contentType, hashKey)

    switch (contentType) {
      case HistoryNetworkContentTypes.BlockHeader: {
        try {
          const header = BlockHeader.fromRLPSerializedHeader(Buffer.from(value), {
            hardforkByBlockNumber: true,
          })
          if (toHexString(header.hash()) !== hashKey) {
            this.logger(`Block header content doesn't match header hash ${hashKey}`)
            return
          }
          if (
            Number(header.number) === this.accumulator.currentHeight() + 1 &&
            header.parentHash.equals(
              this.accumulator.currentEpoch[this.accumulator.currentEpoch.length - 1].blockHash
            )
          ) {
            if (this.accumulator.currentEpoch.length === EPOCH_SIZE) {
              const currentEpoch = EpochAccumulator.serialize(this.accumulator.currentEpoch)

              const currentEpochHash = toHexString(
                EpochAccumulator.hashTreeRoot(this.accumulator.currentEpoch)
              )
              this.addContentToHistory(
                chainId,
                HistoryNetworkContentTypes.EpochAccumulator,
                currentEpochHash,
                currentEpoch
              )
            }
            // Update the header accumulator if the block header is the next in the chain
            this.accumulator.updateAccumulator(header)
            this.logger(
              `Updated header accumulator at slot ${this.accumulator.currentEpoch.length}/${EPOCH_SIZE} of current Epoch`
            )
            this.client.db.put(
              getHistoryNetworkContentId(1, HistoryNetworkContentTypes.HeaderAccumulator),
              toHexString(HeaderAccumulatorType.serialize(this.accumulator))
            )
          }
          this.client.db.put(contentId, toHexString(value))
        } catch (err: any) {
          this.logger(`Invalid value provided for block header: ${err.toString()}`)
          return
        }
        break
      }
      case HistoryNetworkContentTypes.BlockBody: {
        let validBlock = false
        let block: Block
        try {
          const headerContentId = getHistoryNetworkContentId(
            1,
            HistoryNetworkContentTypes.BlockHeader,
            hashKey
          )

          const hexHeader = await this.client.db.get(headerContentId)

          // Verify we can construct a valid block from the header and body provided
          block = reassembleBlock(fromHexString(hexHeader), value)
          validBlock = true
        } catch {
          this.logger(
            `Block Header for ${shortId(hashKey)} not found locally.  Querying network...`
          )
          const retrievedHeader = await this.getBlockByHash(hashKey, false)
          try {
            if (retrievedHeader instanceof Block) validBlock = true
          } catch {}
        }
        if (validBlock) {
          this.logger('found valid block')
          this.client.db.put(contentId, toHexString(value))
          await this.receiptManager.saveReceipts(block!)
        } else {
          this.logger(`Could not verify block content`)
          // Don't store block body where we can't assemble a valid block
          return
        }
        break
      }
      case HistoryNetworkContentTypes.Receipt:
        this.client.db.put(
          getHistoryNetworkContentId(1, HistoryNetworkContentTypes.Receipt, hashKey),
          toHexString(value)
        )
        break
      case HistoryNetworkContentTypes.EpochAccumulator:
        this.client.db.put(
          getHistoryNetworkContentId(1, HistoryNetworkContentTypes.EpochAccumulator, hashKey),
          toHexString(value)
        )
        break
      case HistoryNetworkContentTypes.HeaderAccumulator:
        this.receiveSnapshot(value)
        break
      default:
        throw new Error('unknown data type provided')
    }

    this.client.emit('ContentAdded', hashKey, contentType, toHexString(value))
    this.logger(
      `added ${
        Object.keys(HistoryNetworkContentTypes)[
          Object.values(HistoryNetworkContentTypes).indexOf(contentType)
        ]
      } for ${hashKey} to content db`
    )
    if (
      contentType !== HistoryNetworkContentTypes.HeaderAccumulator &&
      this.routingTable.values().length > 0
    ) {
      // Gossip new content to network (except header accumulators)
      this.gossipQueue.push([hashKey, contentType])
      if (this.gossipQueue.length >= 26) {
        await this.gossipHistoryNetworkContent(this.gossipQueue)
        this.gossipQueue = []
      }
    }
  }

  /**
   * Gossips recently added content to the nearest 5 nodes
   * @param blockHash hex prefixed blockhash of content to be gossipped
   * @param contentType type of content being gossipped
   */
  private gossipHistoryNetworkContent = async (
    gossipQueue: [string, HistoryNetworkContentTypes][]
  ) => {
    let nearestPeers: ENR[] = []
    const contentIds = gossipQueue.map(([blockHash, contentType]) => {
      return getHistoryNetworkContentId(1, contentType, blockHash)
    })
    const encodedKeys = gossipQueue.map(([blockHash, _contentType], idx) => {
      return HistoryNetworkContentKeyUnionType.serialize({
        selector: gossipQueue[idx][1],
        value: { chainId: 1, blockHash: fromHexString(blockHash) },
      })
    })
    contentIds.forEach((contentId) => {
      nearestPeers = [...nearestPeers, ...this.routingTable.nearest(contentId, 5)]
    })
    nearestPeers.forEach((peer) => {
      const _encodedKeys = [...new Set(encodedKeys)].filter(
        (n) => !this.routingTable.contentKeyKnownToPeer(peer.nodeId, toHexString(n))
      )
      // If peer hasn't already been OFFERed this contentKey and the content is within the peer's advertised radius, OFFER
      if (_encodedKeys.length > 0) {
        this.sendOffer(peer.nodeId, _encodedKeys)
      }
    })
  }
}
