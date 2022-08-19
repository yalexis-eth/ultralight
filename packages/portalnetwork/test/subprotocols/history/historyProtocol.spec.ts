import { ENR, EntryStatus, toHex } from '@chainsafe/discv5'
import { BlockHeader } from '@ethereumjs/block'
import { Common, Hardfork } from '@ethereumjs/common'
import tape from 'tape'
import * as td from 'testdouble'
import {
  fromHexString,
  PortalNetwork,
  toHexString,
  ProtocolId,
  serializedContentKeyToContentId,
} from '../../../src/index.js'
import { TransportLayer } from '../../../src/client/index.js'
import { HistoryProtocol } from '../../../src/subprotocols/history/history.js'
import {
  HistoryNetworkContentKeyUnionType,
  HistoryNetworkContentTypes,
} from '../../../src/subprotocols/history/types.js'
import { createRequire } from 'module'
import { EpochAccumulator, getHistoryNetworkContentId } from '../../../dist/index.js'
import { RLP } from 'rlp'
import { arrToBufArr, bufArrToArr } from '@ethereumjs/util'

const require = createRequire(import.meta.url)

tape('history Protocol message handler tests', async (t) => {
  const node = await PortalNetwork.create({
    bindAddress: '192.168.0.1',
    transport: TransportLayer.WEB,
    supportedProtocols: [ProtocolId.HistoryNetwork],
  })

  node.sendPortalNetworkMessage = td.func<any>()
  node.sendPortalNetworkResponse = td.func<any>()

  t.test('FINDCONTENT/FOUNDCONTENT message handlers', async (st) => {
    st.plan(1)
    const protocol = new HistoryProtocol(node, 2n) as any
    const remoteEnr =
      'enr:-IS4QG_M1lzTXzQQhUcAViqK-WQKtBgES3IEdQIBbH6tlx3Zb-jCFfS1p_c8Xq0Iie_xT9cHluSyZl0TNCWGlUlRyWcFgmlkgnY0gmlwhKRc9EGJc2VjcDI1NmsxoQMo1NBoJfVY367ZHKA-UBgOE--U7sffGf5NBsNSVG629oN1ZHCCF6Q'
    const decodedEnr = ENR.decodeTxt(remoteEnr)
    protocol.routingTable.insertOrUpdate(decodedEnr, EntryStatus.Connected)
    const key = HistoryNetworkContentKeyUnionType.serialize({
      selector: 1,
      value: {
        chainId: 1,
        blockHash: fromHexString(
          '0x88e96d4537bea4d9c05d12549907b32561d3bf31f45aae734cdc119f13406cb6'
        ),
      },
    })
    const findContentResponse = Uint8Array.from([5, 1, 97, 98, 99])
    protocol.addContentToHistory = td.func<any>()
    td.when(
      node.sendPortalNetworkMessage(
        td.matchers.anything(),
        td.matchers.anything(),
        td.matchers.anything()
      )
    ).thenResolve(Buffer.from(findContentResponse))
    const res = await protocol.sendFindContent(decodedEnr.nodeId, key)
    st.deepEqual(res.value, Buffer.from([97, 98, 99]), 'got correct response for content abc')

    // TODO: Write good `handleFindContent` tests
  })

  t.test('Should store and retrieve block header and body from DB', async (st) => {
    const node = await PortalNetwork.create({ transport: TransportLayer.WEB })
    const protocol = new HistoryProtocol(node, 2n) as any
    st.plan(1)
    const block1Rlp =
      '0xf90211a0d4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3a01dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d493479405a56e2d52c817161883f50c441c3228cfe54d9fa0d67e4d450343046425ae4271474353857ab860dbc0a1dde64b41b5cd3a532bf3a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421b90100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008503ff80000001821388808455ba422499476574682f76312e302e302f6c696e75782f676f312e342e32a0969b900de27b6ac6a67742365dd65f55a0526c41fd18e1b16f1a1215c2e66f5988539bd4979fef1ec4'
    const block1Hash = '0x88e96d4537bea4d9c05d12549907b32561d3bf31f45aae734cdc119f13406cb6'
    await protocol.addContentToHistory(
      1,
      HistoryNetworkContentTypes.BlockHeader,
      block1Hash,
      fromHexString(block1Rlp)
    )
    const contentKey = HistoryNetworkContentKeyUnionType.serialize({
      selector: HistoryNetworkContentTypes.BlockHeader,
      value: {
        chainId: 1,
        blockHash: fromHexString(block1Hash),
      },
    })

    const val = await node.db.get(serializedContentKeyToContentId(contentKey))
    const header = BlockHeader.fromRLPSerializedHeader(Buffer.from(fromHexString(val)), {
      hardforkByBlockNumber: true,
    })
    st.equal(header.number, 1n, 'retrieved block header based on content key')
    st.end()
  })
  t.test('Should store and retrieve an EpochAccumulator from DB', async (st) => {
    const node = await PortalNetwork.create({ transport: TransportLayer.WEB })
    const protocol = new HistoryProtocol(node, 2n) as HistoryProtocol
    const epochAccumulator = require('../../integration/testEpoch.json')
    const rebuilt = EpochAccumulator.deserialize(fromHexString(epochAccumulator.serialized))
    const hashRoot = EpochAccumulator.hashTreeRoot(rebuilt)
    const contentId = getHistoryNetworkContentId(1, 3, toHexString(hashRoot))
    await protocol.addContentToHistory(
      1,
      3,
      toHexString(hashRoot),
      fromHexString(epochAccumulator.serialized)
    )
    const fromDB = await node.db.get(contentId)
    st.equal(fromDB, epochAccumulator.serialized, 'Retrive EpochAccumulator test passed.')
  })
})

tape(
  'Should not store block headers where hash generated from block header does not match provided hash',
  async (t) => {
    const common = new Common({ chain: 1, hardfork: Hardfork.London })
    const header = BlockHeader.fromHeaderData({ number: 100000000000000 }, { common })
    const headerValues = header.raw()
    headerValues[15] = Buffer.from([9])
    const node = await PortalNetwork.create({ transport: TransportLayer.WEB })
    const protocol = new HistoryProtocol(node, 2n) as HistoryProtocol
    protocol.addContentToHistory(
      1,
      0,
      toHexString(header.hash()),
      RLP.encode(bufArrToArr(headerValues))
    )
    try {
      await protocol.client.db.get(getHistoryNetworkContentId(1, 0, toHexString(header.hash())))
      t.fail('should not find header')
    } catch (err: any) {
      t.equal(err.message, 'NotFound', 'did not find header in db')
    }
    t.end()
  }
)
