import type { AssetInfo } from '../config/assets.js';
import type { ChainInfo } from '../config/chains.js';
import type { Constraints } from './request.schema.js';

/** Request after chain/asset resolution and policy merge. */
export interface ResolvedRequest {
  requestId: string;
  sourceChain: ChainInfo;
  destinationChain: ChainInfo;
  sourceAsset: AssetInfo;
  destinationAsset: AssetInfo;
  amount: bigint;
  sender?: `0x${string}`;
  recipient?: `0x${string}`;
  policy: EffectivePolicy;
  providers: string[];
  maxAlternatives: number;
}

export interface EffectivePolicy {
  selection: 'highest_net_output' | 'fastest';
  slippageBps: number;
  maxValueLossBps: number;
  minOutput?: bigint;
  maxTimeSeconds?: number;
  maxTotalCostUsdMicro?: bigint;
  requireExecutable: boolean;
  includeReview: boolean;
  raw: Constraints;
}

export type Certainty = 'quoted' | 'estimated';

export interface CostItem {
  kind: 'gas' | 'fee';
  label: string;
  /** null = could not be priced; validation turns this into REVIEW. */
  usdMicro: bigint | null;
  certainty: Certainty;
  token?: { symbol: string; chainId: number; amount: string; decimals?: number };
}

/** Provider-independent quote. Amounts are integer base units. */
export interface NormalizedQuote {
  provider: string;
  tool?: string;
  quoteId: string;
  sourceChainId: number;
  destinationChainId: number;
  sourceToken: string;
  destinationToken: string;
  inputAmount: bigint;
  expectedOutput: bigint;
  minOutput: bigint | null;
  estimatedTimeSeconds: number | null;
  fetchedAt: number;
  expiresAt: number;
  executionAvailable: boolean;
  executionTarget?: string;
  approvalSpender?: string;
  /** Costs paid on top of the input that are NOT already reflected in expectedOutput. */
  extraCosts: CostItem[];
  /** Fees already deducted from expectedOutput; informational only, never subtracted again. */
  includedFees: CostItem[];
  limits?: { minInput?: bigint; maxInput?: bigint };
  /** Prices the provider attached to its quote (micro-USD per whole token). */
  priceHints?: { input?: bigint; output?: bigint };
  warnings: string[];
  /** Hard problems the provider itself reported (e.g. amount too low); always rejected. */
  flags?: { code: string; message: string }[];
  simulated?: boolean;
  /** Opaque provider data needed for execution; never returned to clients. */
  executionData?: unknown;
}

export type RiskStatus = 'PASS' | 'REVIEW' | 'REJECT';

export interface RiskFinding {
  code: string;
  severity: 'reject' | 'review' | 'warn';
  message: string;
}

export interface CostBreakdown {
  inputUsdMicro: bigint | null;
  receivedUsdMicro: bigint | null;
  extraCostUsdMicro: bigint | null;
  netUsdMicro: bigint | null;
  /** input - net: everything the user gives up, including included fees and slippage. */
  totalCostUsdMicro: bigint | null;
  includedFeesUsdMicro: bigint | null;
  minOutputUsdMicro: bigint | null;
  valueLossBps: bigint | null;
  complete: boolean;
  priceSources: { input?: string; output?: string };
}

export interface EvaluatedRoute {
  quote: NormalizedQuote;
  cost: CostBreakdown;
  risk: { status: RiskStatus; findings: RiskFinding[] };
}
