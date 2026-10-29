import { getAddress, isAddress, isHex } from 'viem';
import type { CostItem, NormalizedQuote, ResolvedRequest } from '../schemas/quote.schema.js';
import { ProviderError } from '../utils/errors.js';
import { buildUrl, fetchJson } from '../utils/http.js';
import { parseUint, tryParseDecimal, USD_SCALE } from '../utils/units.js';
import { verifyLifiCalldata } from '../execution/calldata-verify.js';
import type { PreparedTx, ProviderContext, ProviderStatus, RouteProvider, Support } from './provider-interface.js';

interface LifiToken { address?: string; symbol?: string; decimals?: number; chainId?: number; priceUSD?: string }
interface LifiFee { name?: string; amount?: string; amountUSD?: string; included?: boolean; token?: LifiToken }
interface LifiGas { type?: string; amount?: string; amountUSD?: string; token?: LifiToken }
interface LifiQuote {
  id?: string;
  tool?: string;
  action?: { fromChainId?: number; toChainId?: number; fromToken?: LifiToken; toToken?: LifiToken; fromAmount?: string; fromAddress?: string; toAddress?: string };
  estimate?: {
    fromAmount?: string;
    toAmount?: string;
    toAmountMin?: string;
    approvalAddress?: string;
    executionDuration?: number;
    feeCosts?: LifiFee[];
    gasCosts?: LifiGas[];
  };
  transactionRequest?: { to?: string; data?: string; value?: string; gasLimit?: string; chainId?: number; from?: string };
}

function costItem(kind: 'gas' | 'fee', label: string, c: LifiFee | LifiGas, certainty: 'quoted' | 'estimated'): CostItem {
  return {
    kind,
    label,
    usdMicro: tryParseDecimal(c.amountUSD, USD_SCALE),
    certainty,
    token: c.token?.symbol && c.amount
      ? { symbol: c.token.symbol, chainId: Number(c.token.chainId ?? 0), amount: c.amount, decimals: c.token.decimals }
      : undefined,
  };
}

function hexToBig(v: unknown): bigint | null {
  if (typeof v !== 'string') return null;
  if (/^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  return parseUint(v);
}

export class LifiAdapter implements RouteProvider {
  readonly id = 'lifi';
  readonly displayName = 'LI.FI';

  supports(_req: ResolvedRequest): Support {
    return { ok: true };
  }

  private headers(ctx: ProviderContext): Record<string, string> | undefined {
    return ctx.config.lifi.apiKey ? { 'x-lifi-api-key': ctx.config.lifi.apiKey } : undefined;
  }

  async quote(req: ResolvedRequest, ctx: ProviderContext): Promise<NormalizedQuote[]> {
    const cfg = ctx.config;
    const usingPlaceholder = !req.sender;
    const fromAddress = req.sender ?? cfg.lifi.quotePlaceholderAddress;
    const url = buildUrl(cfg.lifi.baseUrl, 'quote', {
      fromChain: req.sourceChain.id,
      toChain: req.destinationChain.id,
      fromToken: req.sourceAsset.address,
      toToken: req.destinationAsset.address,
      fromAmount: req.amount.toString(),
      fromAddress,
      toAddress: req.recipient ?? (usingPlaceholder ? undefined : req.sender),
      slippage: (req.policy.slippageBps / 10_000).toString(),
      integrator: cfg.lifi.integrator,
    });
    let raw: LifiQuote;
    try {
      raw = (await fetchJson(url, {
        provider: this.id,
        fetch: ctx.fetch,
        timeoutMs: cfg.providerTimeoutMs,
        retries: cfg.providerRetries,
        headers: this.headers(ctx),
        signal: ctx.signal,
        maxBytes: 2_000_000,
      })) as LifiQuote;
    } catch (e) {
      if (e instanceof ProviderError && e.httpStatus === 404) throw new ProviderError(this.id, 'NO_ROUTE', 'LI.FI found no route', 404);
      throw e;
    }
    return [this.normalize(raw, req, ctx, usingPlaceholder)];
  }

  normalize(raw: LifiQuote, req: ResolvedRequest, ctx: ProviderContext, usingPlaceholder: boolean): NormalizedQuote {
    const est = raw?.estimate;
    const act = raw?.action;
    const toAmount = parseUint(est?.toAmount);
    const fromAmount = parseUint(est?.fromAmount ?? act?.fromAmount);
    if (!est || !act || toAmount === null || fromAmount === null) {
      throw new ProviderError(this.id, 'BAD_RESPONSE', 'LI.FI quote is missing estimate/action amounts');
    }
    const warnings: string[] = [];
    const extraCosts: CostItem[] = [];
    const includedFees: CostItem[] = [];
    for (const f of est.feeCosts ?? []) {
      // included=true => already reflected in toAmount; never subtract again.
      if (f.included === true) includedFees.push(costItem('fee', f.name ?? 'fee', f, 'quoted'));
      else extraCosts.push(costItem('fee', f.name ?? 'fee', f, 'quoted'));
    }
    for (const g of est.gasCosts ?? []) extraCosts.push(costItem('gas', `gas:${g.type ?? 'SEND'}`, g, 'estimated'));
    if ((est.gasCosts ?? []).length === 0) {
      // Missing data is never "free": an unpriced item makes the cost incomplete (REVIEW).
      extraCosts.push({ kind: 'gas', label: 'gas:SEND (not provided)', usdMicro: null, certainty: 'estimated' });
      warnings.push('LI.FI returned no gas cost; source-chain gas is unpriced.');
    }

    const tx = raw.transactionRequest;
    const txOk = !!tx && typeof tx.to === 'string' && isAddress(tx.to) && typeof tx.data === 'string' && isHex(tx.data);
    if (usingPlaceholder) warnings.push('Quoted without sender address; call /v1/routes/prepare with sender for executable data.');

    const now = ctx.now();
    const priceIn = tryParseDecimal(act.fromToken?.priceUSD, USD_SCALE);
    const priceOut = tryParseDecimal(act.toToken?.priceUSD, USD_SCALE);
    const duration = Number(est.executionDuration);

    return {
      provider: this.id,
      tool: raw.tool,
      quoteId: String(raw.id ?? `lifi-${now}`),
      sourceChainId: Number(act.fromChainId),
      destinationChainId: Number(act.toChainId),
      sourceToken: String(act.fromToken?.address ?? ''),
      destinationToken: String(act.toToken?.address ?? ''),
      inputAmount: fromAmount,
      expectedOutput: toAmount,
      minOutput: parseUint(est.toAmountMin),
      estimatedTimeSeconds: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
      fetchedAt: now,
      expiresAt: now + ctx.config.quoteTtlMs,
      executionAvailable: txOk && !usingPlaceholder,
      executionTarget: txOk ? getAddress(tx!.to!) : undefined,
      approvalSpender: est.approvalAddress && isAddress(est.approvalAddress) ? getAddress(est.approvalAddress) : undefined,
      extraCosts,
      includedFees,
      priceHints: { input: priceIn ?? undefined, output: priceOut ?? undefined },
      warnings,
      executionData: txOk ? { transactionRequest: tx, tool: raw.tool, actionFrom: act.fromAddress, actionTo: act.toAddress } : undefined,
    };
  }

  async buildTransaction(quote: NormalizedQuote, _req: ResolvedRequest, _ctx: ProviderContext): Promise<PreparedTx> {
    const data = quote.executionData as { transactionRequest?: LifiQuote['transactionRequest'] } | undefined;
    const tx = data?.transactionRequest;
    if (!tx || typeof tx.to !== 'string' || !isAddress(tx.to) || typeof tx.data !== 'string' || !isHex(tx.data)) {
      throw new ProviderError(this.id, 'BAD_RESPONSE', 'LI.FI quote has no valid transactionRequest');
    }
    const value = hexToBig(tx.value ?? '0x0');
    if (value === null) throw new ProviderError(this.id, 'BAD_RESPONSE', 'invalid transaction value');
    const gasLimit = tx.gasLimit !== undefined ? hexToBig(tx.gasLimit) ?? undefined : undefined;
    return {
      chainId: Number(tx.chainId ?? quote.sourceChainId),
      to: getAddress(tx.to),
      data: tx.data as `0x${string}`,
      value,
      gasLimit,
    };
  }

  verifyTransaction(tx: PreparedTx, quote: NormalizedQuote, req: ResolvedRequest): string[] {
    const d = quote.executionData as { actionFrom?: string; actionTo?: string } | undefined;
    const p: string[] = [];
    if (!d?.actionTo || !req.recipient || d.actionTo.toLowerCase() !== req.recipient.toLowerCase()) p.push('quote action.toAddress != recipient');
    if (!d?.actionFrom || !req.sender || d.actionFrom.toLowerCase() !== req.sender.toLowerCase()) p.push('quote action.fromAddress != sender');
    return [...p, ...verifyLifiCalldata(tx.data, req)];
  }

  async status(
    args: { txHash: string; sourceChainId: number; destinationChainId: number; tool?: string },
    ctx: ProviderContext,
  ): Promise<ProviderStatus> {
    const url = buildUrl(ctx.config.lifi.baseUrl, 'status', {
      txHash: args.txHash,
      fromChain: args.sourceChainId,
      toChain: args.destinationChainId,
      bridge: args.tool,
    });
    let res: {
      status?: string;
      substatus?: string;
      substatusMessage?: string;
      sending?: { txHash?: string };
      receiving?: { txHash?: string; amount?: string };
    };
    try {
      res = (await fetchJson(url, {
        provider: this.id,
        fetch: ctx.fetch,
        timeoutMs: ctx.config.providerTimeoutMs,
        retries: ctx.config.providerRetries,
        headers: this.headers(ctx),
        signal: ctx.signal,
        maxBytes: 500_000,
      })) as typeof res;
    } catch (e) {
      if (e instanceof ProviderError && e.httpStatus === 404) return { state: 'NOT_FOUND' };
      throw e;
    }
    const s = String(res?.status ?? '').toUpperCase();
    const sub = res?.substatus ? String(res.substatus).toUpperCase() : undefined;
    let state: ProviderStatus['state'] = 'UNKNOWN';
    if (s === 'PENDING') state = 'PENDING';
    else if (s === 'NOT_FOUND') state = 'NOT_FOUND';
    else if (s === 'FAILED' || s === 'INVALID') state = 'FAILED';
    else if (s === 'DONE') state = sub === 'REFUNDED' ? 'REFUNDED' : sub === 'PARTIAL' ? 'PARTIAL' : 'DONE';
    return {
      state,
      substatus: sub,
      sourceTxHash: res?.sending?.txHash,
      destinationTxHash: res?.receiving?.txHash,
      receivedAmount: parseUint(res?.receiving?.amount) ?? undefined,
      message: res?.substatusMessage,
    };
  }
}
