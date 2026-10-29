# BridgePilot

ابزار بهینه‌سازی مسیر انتقال بین‌زنجیره‌ای برای ایجنت‌های هوش مصنوعی + نمونه آزمایشی پروتکل بریج اختصاصی (Lock & Mint با تأیید آستانه‌ای، فقط شبکه‌های EVM آزمایشی).

> **این یک بریج مبتنی بر اعتماد به امضاکنندگان است** ([`docs/trust-model.md`](docs/trust-model.md)): قرارداد امضای اکثریت امضاکنندگان را بررسی می‌کند، نه اثبات رمزنگاری‌شده رخداد مبدأ. خسارت در صورت تبانی با سقف هر شبکه و rate limit محدود می‌شود، نه حذف.
>
> **آنچه ادعا نمی‌کنیم:** «همه شبکه‌ها» (فقط EVM؛ Solana و UTXO پشتیبانی نمی‌شوند)، «امنیت کامل» (تأیید مبتنی بر اعتماد به امضاکنندگان، ممیزی‌نشده)، و «ارزان‌ترین مسیر بازار» (بهترین خروجی خالص در میان مظنه‌های دریافت‌شده، با زمان و منبع داده).

پروژه دو بخش دارد که مطابق دو سند معماری ساخته شده‌اند:

| بخش | وضعیت | مسیر |
|---|---|---|
| **۱. موتور مسیریابی + API پولی** (LI.FI، Across) | قابل اجرا؛ آداپتورها با fixtureهای منطبق بر مستندات API آزموده شده‌اند | `src/`, `apps/api/` |
| **۲. پروتکل بریج اختصاصی** (قراردادها + attester + relayer) | **فقط testnet** — ممیزی نشده؛ قراردادها روی mainnet revert می‌کنند | `contracts/evm/`, `protocol/` |

---

## شروع سریع

```bash
npm install
cp .env.example .env

# حالت آفلاین (مظنه‌های شبیه‌سازی‌شده و برچسب‌دار)
PROVIDER_MODE=simulated npm run dev

# حالت واقعی
PROVIDER_MODE=live npm run dev
```

```bash
curl -s localhost:8080/v1/routes/quote -H 'content-type: application/json' -d '{
  "source_chain": "base", "destination_chain": "arbitrum",
  "source_token": "USDC", "destination_token": "USDC",
  "amount": "100000000",
  "sender": "0x...", "recipient": "0x...",
  "constraints": { "max_slippage_bps": 50, "max_time_seconds": 600 }
}'
```
`amount` همیشه عدد صحیح در کوچک‌ترین واحد توکن است (USDC: ۶ رقم اعشار ← ۱۰۰ USDC = `"100000000"`).

## API

| Endpoint | کار |
|---|---|
| `POST /v1/routes/quote` | کشف موازی، محاسبه خروجی خالص، فیلتر ریسک، رتبه‌بندی قطعی |
| `POST /v1/routes/prepare` | مظنه تازه + بررسی مجدد + رمزگشایی calldata + تراکنش‌های **امضانشده** (approve دقیق، نه نامحدود) |
| `GET /v1/routes/status/{prepared_id}?tx_hash=0x…` | پیگیری انتقال، ثبت اختلاف خروجی واقعی با مظنه |
| `GET /v1/assets` | شبکه‌ها، توکن‌ها، ارائه‌دهندگان |
| `GET /.well-known/ai-tool.json` | manifest ابزار |
| `GET /openapi.json` · `GET /health` | سلامت سرویس، وضعیت circuit هر ارائه‌دهنده، ذخیره‌ساز پایدار |
| `GET /metrics` · `GET /v1/quality/report` | فقط با کلید admin |

### منطق تصمیم‌گیری (همه قطعی، بدون مدل زبانی)
- **هزینه:** `V_net = V_received − C_extra`. کارمزدهای `included` فقط نمایش داده می‌شوند و دوباره کم نمی‌شوند. همه محاسبات پولی با `bigint` و micro-USD.
- **فیلترهای اجباری** (`validation-engine.ts`): تطابق شبکه/توکن/مبلغ، انقضا، خروجی غیرمنطقی، لغزش، حداقل خروجی کاربر، زمان، سقف هزینه، سقف از دست رفتن ارزش، محدودیت نقدینگی، denylist امنیتی، allowlist قرارداد هدف و spender. **نبود داده = REVIEW، نه PASS.**
- **رتبه‌بندی:** بیشترین خروجی خالص؛ در محدوده تحمل (پیش‌فرض ۱bps) زمان و تعداد هشدار تعیین‌کننده‌اند. ترتیب ورودی روی نتیجه اثر ندارد (آزمون property).
- **قیمت‌ها** یک‌بار برای کل درخواست تعیین می‌شوند (بازار مستقل ← peg علامت‌دار ← میانه قیمت ارائه‌دهندگان با وضعیت REVIEW). هیچ ارائه‌دهنده‌ای مظنه خودش را قیمت‌گذاری نمی‌کند.
- **سقف‌های سرور** فقط سخت‌تر می‌شوند؛ مقدار شُل‌تر کاربر clamp و گزارش می‌شود.
- **prepare** فقط برای ارائه‌دهنده‌ای ممکن است که calldata آن را بتوانیم رمزگشایی کنیم؛ مسیر LI.FI با تابعی غیر از facetهای `BridgeData` (مثلاً فقط swap) عمداً رد می‌شود.

### پرداخت و دسترسی
- `X402_MODE=facilitator`: پاسخ 402 با `accepts`؛ بررسی محلی (payee، مبلغ، انقضا، nonce تکراری) سپس verify و **settle فقط پس از موفقیت درخواست**. درخواست ناموفق هزینه‌ای ندارد.
- `API_KEYS`: مشترکان بدون x402. `ADMIN_KEYS`: متریک و گزارش کیفیت.
- rate limit به‌ازای هر کلید/IP.

---

## پروتکل بریج (testnet)

```bash
cd contracts/evm
forge build
forge test            # unit + fuzz (1000 اجرا) + invariant (128×64)
```

قراردادها: `BridgeVault` · `BridgeToken` · `MessageVerifier` · `BridgeExecutor` · `ReplayProtection` · `RateLimiter` · `EmergencyController` · `FeeController`.
تأیید: امضای EIP-712 از **اکثریت مطلق** امضاکنندگان (مثلاً ۲ از ۳)، چرخش با تأخیر زمانی.

استقرار روی testnet: `contracts/evm/script/Deploy.s.sol` (راهنما در سربرگ فایل).

Off-chain (`protocol/`): `attester.ts` (هر attester از RPC خودش و طبق سیاست نهایی‌شدن همان شبکه امضا می‌کند؛ امضای بازپرداخت فقط پس از لغو نهایی‌شده)، `relayer.ts` (ماشین حالت پایدار در SQLite، ادامه پس از restart، لغو و بازپرداخت، هشدار)، `finality.ts` (رجیستری شبکه‌ها و سیاست finality)، `verify-deployment.ts` (بررسی پس از استقرار).

تأیید پیام: قراردادها از طریق `VerifierRouter` تأیید می‌کنند؛ امروز امضای آستانه‌ای (سطح ۱، مبتنی بر اعتماد)، با مسیر ارتقای **یک‌طرفه** به اثبات رمزنگاری‌شده برای هر مسیر (`docs/verifier-upgrade.md`). تا فعال و ممیزی‌شدن چنین اثباتی، بریج trustless نیست.

مدیریت: admin همه قراردادها یک `TimelockController` است که فقط یک multisig می‌تواند در آن پیشنهاد و اجرا کند (`script/Deploy.s.sol`). پیش از پذیرش انتقال: `npx tsx protocol/verify-deployment.ts deployment.json`.

مستندات: [`docs/trust-model.md`](docs/trust-model.md) · [`docs/protocol-spec.md`](docs/protocol-spec.md) · [`docs/threat-model.md`](docs/threat-model.md) · [`docs/incident-response.md`](docs/incident-response.md) · [`docs/operations.md`](docs/operations.md)

---

## آزمون‌ها

```bash
npm test          # Vitest: موتورها، آداپتورها، API، x402، fuzz امنیتی، e2e پروتکل روی دو anvil
npm run test:3x   # کل خط لوله ۳ بار با seedهای مختلف + forge؛ خروجی test-report.json
```
e2e پروتکل به `anvil` نیاز دارد (`ANVIL_PATH`) و در نبود آن skip می‌شود.

## محدودیت‌های شناخته‌شده
- آداپتورهای LI.FI و Across با داده واقعی شبکه آزموده نشده‌اند (دسترسی شبکه در محیط ساخت مسدود بود)؛ fixtureها بر اساس مستندات رسمی‌اند. پیش از عرضه، با کلید API واقعی یک بار تست شوند.
- اجرای Across (`depositV3`) پیش‌فرض خاموش است تا روی testnet تأیید شود.
- قالب manifest باید با مشخصات فعلی OpenSea Agent Tools تطبیق داده شود.
- بدون `STORAGE_PATH` همه‌چیز در حافظه است (فقط توسعه). با آن، رکوردها و nonceهای پرداخت در SQLite برای چند فرایند روی یک میزبان پایدار و اتمیک‌اند؛ برای چند سرور باید PostgreSQL پیاده شود (`docs/operations.md`).
- پروتکل بریج ممیزی نشده و مبتنی بر اعتماد به امضاکنندگان است — برای دارایی واقعی استفاده نشود.
- `node:sqlite` در Node 22 هنوز «experimental» است (هشدار آن خاموش شده).


## آزمون
`npm ci && npm run test:3x` — سه دور کامل و سپس ۱۰ اجرای جداگانه e2e (`--e2e-repeats N`) که همه در `test-report.json` ثبت می‌شوند (`run_id`، `status`، `passed`، `complete`، `e2e_stability`). گزارش در آغاز هر اجرا بی‌اعتبار و در هر مسیر خروج به‌روز می‌شود. Foundry (forge و anvil) **الزامی** است؛ نبودن آن یا هر تست skip‌شده اجرا را شکست می‌دهد. `npm run test:3x -- --app-only` فقط تست‌های برنامه را اجرا می‌کند و در خروجی و `test-report.json` (`complete: false`) اعلام می‌کند که تست قراردادها و e2e پروتکل اجرا نشده‌اند.
