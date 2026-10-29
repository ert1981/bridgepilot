import { decodeAbiParameters, decodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import type { ResolvedRequest } from '../schemas/quote.schema.js';

/**
 * LI.FI bridge facets (startBridgeTokensVia* / swapAndStartBridgeTokensVia*) take ILiFi.BridgeData
 * as their FIRST argument. Decoding it lets us verify what the router will actually do, instead
 * of trusting the provider's JSON. Anything we cannot decode is refused (fail closed).
 */
const BRIDGE_DATA = [
  {
    type: 'tuple',
    components: [
      { name: 'transactionId', type: 'bytes32' },
      { name: 'bridge', type: 'string' },
      { name: 'integrator', type: 'string' },
      { name: 'referrer', type: 'address' },
      { name: 'sendingAssetId', type: 'address' },
      { name: 'receiver', type: 'address' },
      { name: 'minAmount', type: 'uint256' },
      { name: 'destinationChainId', type: 'uint256' },
      { name: 'hasSourceSwaps', type: 'bool' },
      { name: 'hasDestinationCall', type: 'bool' },
    ],
  },
] as const;

export interface LifiBridgeData {
  sendingAssetId: string;
  receiver: string;
  minAmount: bigint;
  destinationChainId: bigint;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
}

export function decodeLifiBridgeData(data: Hex): LifiBridgeData | null {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10 + 64 * 11) return null;
  try {
    const [bd] = decodeAbiParameters(BRIDGE_DATA, `0x${data.slice(10)}`);
    return {
      sendingAssetId: bd.sendingAssetId,
      receiver: bd.receiver,
      minAmount: bd.minAmount,
      destinationChainId: bd.destinationChainId,
      hasSourceSwaps: bd.hasSourceSwaps,
      hasDestinationCall: bd.hasDestinationCall,
    };
  } catch {
    return null;
  }
}

/** Returns a list of problems; empty means the calldata matches the request. */
export function verifyLifiCalldata(data: Hex, req: ResolvedRequest): string[] {
  const bd = decodeLifiBridgeData(data);
  if (!bd) return ['calldata could not be decoded as a LI.FI bridge call (BridgeData); refusing to prepare'];
  const p: string[] = [];
  if (!req.recipient || getAddress(bd.receiver) !== getAddress(req.recipient)) p.push(`calldata receiver ${bd.receiver} != recipient ${req.recipient}`);
  if (bd.destinationChainId !== BigInt(req.destinationChain.id)) p.push(`calldata destination chain ${bd.destinationChainId} != ${req.destinationChain.id}`);
  if (bd.hasDestinationCall) p.push('calldata contains a destination call (arbitrary contract execution) — not allowed');
  if (!bd.hasSourceSwaps) {
    if (getAddress(bd.sendingAssetId) !== getAddress(req.sourceAsset.address)) p.push(`calldata sends ${bd.sendingAssetId}, expected ${req.sourceAsset.address}`);
    if (bd.minAmount !== req.amount) p.push(`calldata bridges ${bd.minAmount}, expected ${req.amount}`);
  } else if (bd.minAmount === 0n) {
    p.push('calldata bridges zero after source swap');
  }
  return p;
}

const DEPOSIT_V3 = parseAbi([
  'function depositV3(address depositor,address recipient,address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,address exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message)',
]);

export function verifyAcrossCalldata(data: Hex, req: ResolvedRequest, expectedOutput: bigint): string[] {
  let args;
  try {
    ({ args } = decodeFunctionData({ abi: DEPOSIT_V3, data }));
  } catch {
    return ['calldata is not an Across depositV3 call'];
  }
  const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destChain, , , , , message] = args;
  const p: string[] = [];
  if (getAddress(depositor) !== getAddress(req.sender!)) p.push('depositor != sender');
  if (getAddress(recipient) !== getAddress(req.recipient!)) p.push('recipient mismatch');
  if (getAddress(inputToken) !== getAddress(req.sourceAsset.address)) p.push('input token mismatch');
  if (getAddress(outputToken) !== getAddress(req.destinationAsset.address)) p.push('output token mismatch');
  if (inputAmount !== req.amount) p.push('input amount mismatch');
  if (outputAmount !== expectedOutput) p.push('output amount mismatch');
  if (destChain !== BigInt(req.destinationChain.id)) p.push('destination chain mismatch');
  if (message !== '0x') p.push('non-empty message (destination call) not allowed');
  return p;
}
