import { encodeFunctionData, getAddress, isAddress } from 'viem';
import type { CostItem, NormalizedQuote, ResolvedRequest } from '../schemas/quote.schema.js';
import { ProviderError } from '../utils/errors.js';
import { buildUrl, fetchJson } from '../utils/http.js';
import { parseUint, usdMicroOf } from '../utils/units.js';
import { verifyAcrossCalldata } from '../execution/calldata-verify.js';
import type { PreparedTx, ProviderContext, ProviderStatus, RouteProvider, Support } from './provider-interface.js';

interface AcrossFees {
  id?: string;
  estimatedFillTimeSec?: number;
  timestamp?: string | number;
  isAmountTooLow?: boolean;
  quoteBlock?: string;
  exclusiveRelayer?: string;
  exclusivityDeadline?: number | string;
  spokePoolAddress?: string;
  totalRelayFee?: { pct?: string; total?: string };
  limits?: { minDeposit?: string; maxDeposit?: string };
  fillDeadline?: string | number;
  outputAmount?: string;
  inputToken?: { address?: string; decimals?: number; chainId?: number; symbol?: string };
  outputToken?: { address?: string; decimals?: number; chainId?: number; symbol?: string };
}

const DEPOSIT_V3_ABI = [
  {
    type: 'function',
    name: 'depositV3',
    stateMutability: 'payable',
    inputs: [
      { name: 'depositor', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'inputToken', type: 'address' },
      { name: 'outputToken', type: 'address' },
      { name: 'inputAmount', type: 'uint256' },
      { name: 'outputAmount', type: 'uint256' },
      { name: 'destinationChainId', type: 'uint256' },
      { name: 'exclusiveRelayer', type: 'address' },
      { name: 'quoteTimestamp', type: 'uint32' },
      { name: 'fillDeadline', type: 'uint32' },
      { name: 'exclusivityDeadline', type: 'uint32' },
      { name: 'message', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

export class AcrossAdapter implements RouteProvider {
  readonly id = 'across';
  readonly displayName = 'Across Protocol';

  supports(req: ResolvedRequest): Support {
    if (req.sourceAsset.native || req.destinationAsset.native) {
      return { ok: false, reason: 'Across adapter supports ERC-20 tokens only in v1 (native ETH requires the WETH flow).' };
    }
    if (req.sourceAsset.peg !== req.destinationAsset.peg || req.sourceAsset.symbol !== req.destinationAsset.symbol) {
      return { ok: false, reason: 'Across adapter only quotes same-asset bridging in v1.' };
    }
    return { ok: true };
  }

  async quote(req: ResolvedRequest, ctx: ProviderContext): Promise<NormalizedQuote[]> {
    const cfg = ctx.config;
    const url = buildUrl(cfg.across.baseUrl, 'suggested-fees', {
      inputToken: req.sourceAsset.address,
      outputToken: req.destinationAsset.address,
      originChainId: req.sourceChain.id,
      destinationChainId: req.destinationChain.id,
      amount: req.amount.toString(),
      recipient: req.recipient,
    });
    const raw = (await fetchJson(url, {
      provider: this.id,
      fetch: ctx.fetch,
      timeoutMs: cfg.providerTimeoutMs,
      retries: cfg.providerRetries,
      headers: cfg.across.apiKey ? { authorization: `Bearer ${cfg.across.apiKey}` } : undefined,
      signal: ctx.signal,
      maxBytes: 200_000,
    })) as AcrossFees;
    return [await this.normalize(raw, req, ctx)];
  }

  async normalize(raw: AcrossFees, req: ResolvedRequest, ctx: ProviderContext): Promise<NormalizedQuote> {
    const relayTotal = parseUint(raw?.totalRelayFee?.total);
    let output = parseUint(raw?.outputAmount);
    if (output === null && relayTotal !== null) output = req.amount > relayTotal ? req.amount - relayTotal : 0n;
    if (output === null) throw new ProviderError(this.id, 'BAD_RESPONSE', 'Across response has neither outputAmount nor totalRelayFee');

    const warnings: string[] = [];
    const flags = raw.isAmountTooLow ? [{ code: 'AMOUNT_BELOW_MIN', message: 'Across reports the amount is below its minimum deposit.' }] : [];

    // Origin gas is paid on top of the input; Across does not price it, so estimate it.
    const extraCosts: CostItem[] = [];
    const gasPrice = await ctx.gas.gasPriceWei(req.sourceChain.id, ctx.signal);
    const native = await ctx.prices.nativePrice(req.sourceChain.id, ctx.signal);
    let gasUsd: bigint | null = null;
    if (gasPrice !== null && native !== null) {
      const wei = gasPrice * ctx.config.across.depositGasUnits;
      gasUsd = usdMicroOf(wei, req.sourceChain.nativeDecimals, native.priceMicro);
    } else {
      warnings.push('Could not estimate origin gas for Across (RPC or native price unavailable).');
    }
    extraCosts.push({ kind: 'gas', label: 'gas:deposit (estimated)', usdMicro: gasUsd, certainty: 'estimated' });

    const includedFees: CostItem[] = relayTotal !== null
      ? [{
          kind: 'fee',
          label: 'across_total_relay_fee',
          usdMicro: null,
          certainty: 'quoted',
          token: { symbol: req.sourceAsset.symbol, chainId: req.sourceChain.id, amount: relayTotal.toString(), decimals: req.sourceAsset.decimals },
        }]
      : [];

    const now = ctx.now();
    const fillDeadlineMs = Number(raw.fillDeadline) * 1000;
    let expiresAt = now + ctx.config.quoteTtlMs;
    if (Number.isFinite(fillDeadlineMs) && fillDeadlineMs > 0) expiresAt = Math.min(expiresAt, fillDeadlineMs);
    const spoke = raw.spokePoolAddress && isAddress(raw.spokePoolAddress) ? getAddress(raw.spokePoolAddress) : undefined;
    const fillTime = Number(raw.estimatedFillTimeSec);

    return {
      provider: this.id,
      tool: 'across',
      quoteId: String(raw.id ?? `${raw.timestamp ?? now}-${raw.quoteBlock ?? '0'}`),
      sourceChainId: Number(raw.inputToken?.chainId ?? req.sourceChain.id),
      destinationChainId: Number(raw.outputToken?.chainId ?? req.destinationChain.id),
      sourceToken: String(raw.inputToken?.address ?? req.sourceAsset.address),
      destinationToken: String(raw.outputToken?.address ?? req.destinationAsset.address),
      inputAmount: req.amount,
      expectedOutput: output,
      // Across fills the exact outputAmount or refunds; there is no slippage band.
      minOutput: output,
      estimatedTimeSeconds: Number.isFinite(fillTime) && fillTime >= 0 ? Math.round(fillTime) : null,
      fetchedAt: now,
      expiresAt,
      executionAvailable: ctx.config.across.executionEnabled && !!spoke && !!req.sender,
      executionTarget: spoke,
      approvalSpender: spoke,
      extraCosts,
      includedFees,
      limits: {
        minInput: parseUint(raw.limits?.minDeposit) ?? undefined,
        maxInput: parseUint(raw.limits?.maxDeposit) ?? undefined,
      },
      warnings,
      flags,
      executionData: {
        timestamp: Number(raw.timestamp),
        fillDeadline: Number(raw.fillDeadline),
        exclusivityDeadline: Number(raw.exclusivityDeadline ?? 0),
        exclusiveRelayer: raw.exclusiveRelayer && isAddress(raw.exclusiveRelayer) ? getAddress(raw.exclusiveRelayer) : '0x0000000000000000000000000000000000000000',
      },
    };
  }

  /**
   * Builds a SpokePool depositV3 call. Disabled unless ACROSS_EXECUTION_ENABLED=true; verify the
   * current SpokePool interface on a testnet before enabling it for real funds.
   */
  async buildTransaction(quote: NormalizedQuote, req: ResolvedRequest, ctx: ProviderContext): Promise<PreparedTx> {
    if (!ctx.config.across.executionEnabled) throw new ProviderError(this.id, 'UNSUPPORTED', 'Across execution is disabled by configuration');
    const d = quote.executionData as { timestamp: number; fillDeadline: number; exclusivityDeadline: number; exclusiveRelayer: `0x${string}` };
    if (!quote.executionTarget || !req.sender || !req.recipient) throw new ProviderError(this.id, 'BAD_RESPONSE', 'missing spoke pool or addresses');
    const u32 = (n: number) => Number.isInteger(n) && n >= 0 && n < 2 ** 32;
    if (!u32(d.timestamp) || !u32(d.fillDeadline) || !u32(d.exclusivityDeadline)) {
      throw new ProviderError(this.id, 'BAD_RESPONSE', 'invalid Across timestamps');
    }
    const data = encodeFunctionData({
      abi: DEPOSIT_V3_ABI,
      functionName: 'depositV3',
      args: [
        req.sender,
        req.recipient,
        getAddress(quote.sourceToken),
        getAddress(quote.destinationToken),
        quote.inputAmount,
        quote.expectedOutput,
        BigInt(quote.destinationChainId),
        d.exclusiveRelayer,
        d.timestamp,
        d.fillDeadline,
        d.exclusivityDeadline,
        '0x',
      ],
    });
    return { chainId: quote.sourceChainId, to: getAddress(quote.executionTarget), data, value: 0n };
  }

  verifyTransaction(tx: PreparedTx, quote: NormalizedQuote, req: ResolvedRequest): string[] {
    return verifyAcrossCalldata(tx.data, req, quote.expectedOutput);
  }

  async status(args: { txHash: string; sourceChainId: number }, ctx: ProviderContext): Promise<ProviderStatus> {
    const url = buildUrl(ctx.config.across.baseUrl, 'deposit/status', { originChainId: args.sourceChainId, depositTxHash: args.txHash });
    let res: { status?: string; fillTx?: string; depositTxHash?: string };
    try {
      res = (await fetchJson(url, {
        provider: this.id,
        fetch: ctx.fetch,
        timeoutMs: ctx.config.providerTimeoutMs,
        retries: ctx.config.providerRetries,
        signal: ctx.signal,
        maxBytes: 100_000,
      })) as typeof res;
    } catch (e) {
      if (e instanceof ProviderError && e.httpStatus === 404) return { state: 'NOT_FOUND' };
      throw e;
    }
    const s = String(res?.status ?? '').toLowerCase();
    const map: Record<string, ProviderStatus['state']> = {
      filled: 'DONE',
      pending: 'PENDING',
      expired: 'FAILED',
      refunded: 'REFUNDED',
      slowfillrequested: 'PENDING',
    };
    return { state: map[s] ?? 'UNKNOWN', sourceTxHash: res?.depositTxHash ?? args.txHash, destinationTxHash: res?.fillTx };
  }
}
