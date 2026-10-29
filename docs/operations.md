# راهنمای عملیات

## ذخیره‌سازی پایدار

| داده | رابط | پیش‌فرض | پایدار |
|---|---|---|---|
| انتقال‌های آماده‌شده، تاریخچه ارائه‌دهندگان | `Store` | حافظه | `SqliteStore` با `STORAGE_PATH` |
| nonceهای پرداخت x402 | `NonceStore` | حافظه | `SqliteNonceStore` (همان فایل) |
| رکوردهای relayer و checkpoint اسکن | `RelayerStore` | حافظه | `SqliteRelayerStore` |

- **یک میزبان، چند فرایند:** همه فرایندها به یک فایل SQLite اشاره کنند (`STORAGE_PATH=/var/lib/bridgepilot/api.sqlite`). حالت WAL و `busy_timeout` فعال است؛ رزرو nonce با `INSERT OR IGNORE` اتمیک است.
- **چند میزبان:** SQLite کافی نیست. همان سه رابط را روی PostgreSQL پیاده کنید:
  ```sql
  CREATE TABLE payment_nonces (key TEXT PRIMARY KEY, expires_at BIGINT NOT NULL);
  -- reserve: DELETE ... WHERE key=$1 AND expires_at <= now; INSERT ... ON CONFLICT DO NOTHING RETURNING key
  CREATE TABLE prepared (id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, data JSONB NOT NULL);
  -- update: SELECT ... FOR UPDATE داخل تراکنش
  CREATE TABLE relayer_records (id TEXT PRIMARY KEY, state TEXT NOT NULL, data JSONB NOT NULL, updated_at BIGINT NOT NULL);
  CREATE TABLE relayer_checkpoints (chain_id TEXT PRIMARY KEY, block NUMERIC NOT NULL);
  ```
  چند نمونه relayer می‌توانند هم‌زمان با یک پایگاه داده کار کنند: هر رکورد با **lease** (`relayer_leases`) فقط به یک نمونه تعلق دارد و آن نمونه پیش از هر اقدام آخرین وضعیت را بارگذاری می‌کند. هر نمونه `ownerId` **ثابت** داشته باشد (مثلاً hostname) تا پس از restart فوراً lease خودش را ادامه دهد. روی PostgreSQL، `tryLease` را با `INSERT ... ON CONFLICT DO UPDATE ... WHERE owner = $2 OR until <= now() RETURNING id` پیاده کنید.
- پشتیبان‌گیری از فایل/پایگاه داده relayer الزامی است؛ از دست رفتن آن خطر مالی ندارد (relayer از `startBlock` دوباره اسکن می‌کند و `processed()` تکرار را مهار می‌کند) اما بازیابی را کند می‌کند.

## ریلیر
- `scan(chainId)` از آخرین checkpoint منهای `reorgMargin` (پیش‌فرض ۶۴ بلوک) اسکن می‌کند.
- پس از restart: `new Relayer(chains, attesters, { store: new SqliteRelayerStore(path) })` همه رکوردها را بازیابی می‌کند و از همان حالت ادامه می‌دهد.
- هشدارها: `onAlert` برای `RECOVERY_REQUIRED` (critical) و ماندن بیش از `stuckAfterMs` در یک حالت (warning). آن را به سامانه هشدار (PagerDuty، Slack، …) وصل کنید.
- داشبورد: `relayer.pendingReport()` همه انتقال‌های ناتمام را با سن، حالت، آخرین خطا و پرچم `stuck` برمی‌گرداند.

- **gate اجباری (در کد):** `new Relayer(...)` بدون `gate` خطا می‌دهد. تنها استثنا `devMode: true` است، و آن هم فقط وقتی همه شبکه‌ها محلی (31337–31339) باشند. در عمل: `gate: { check: readinessGate(cfg, clients, { attesters }) }`.
- **gate فقط «حرکت رو به جلو» را نگه می‌دارد:** وقتی بسته است، هیچ execute/release فرستاده نمی‌شود (هشدار critical)، ولی خواندن، امضاگیری و **بازپرداخت** انتقال‌های لغوشده ادامه دارد — بازپرداخت فقط به فرستنده اصلی برمی‌گردد و روی زنجیره کامل بررسی می‌شود.
- **gate ≠ توقف مسیر:** gate فقط پیکربندی استقرار و attesterهای در حال اجرا را بررسی می‌کند (آدرس‌ها، نقش‌ها، امضاکنندگان، سقف‌ها، سیاست خسارت، quorum واقعی، سلامت finality هر endpoint). توقف سراسری یا توقف یک مسیر **عملیاتی** است: در `operational` گزارش می‌شود ولی gate را نمی‌بندد؛ ریلیر انتقال‌های آن مسیر را در `PAUSED` نگه می‌دارد و لغو/بازپرداخت آن مسیر ادامه می‌یابد.
- **سیاست خسارت (اجباری):** `damagePolicy.reactionTimeSec` و `tokens[].maxChainCap` باید تعریف شوند. gate بررسی می‌کند `chainCap` و `supplyCap` ≤ `maxChainCap`، و برای هر سطل (انتقال و بازیابی، در vault و executor): `ظرفیت + ظرفیت × زمان‌واکنش / پنجره ≤ maxChainCap` — یعنی پیش از اینکه تیم بتواند واکنش نشان دهد، بیش از سقف قابل قبول خارج نشود.
- **lease و نوشتن هم‌زمان:** lease در طول هر گام هر `TTL/3` تمدید می‌شود و درست پیش از ارسال هر تراکنش دوباره تأیید می‌شود. هر رکورد نسخه دارد و ذخیره به‌صورت compare-and-swap است؛ نمونه‌ای که lease را از دست داده یا نسخه قدیمی دارد، هیچ تراکنشی نمی‌فرستد و وضعیت جدیدتر را بازنویسی نمی‌کند (`relayer.stats.superseded`).
- **ذخیره‌ساز پایدار (اجباری):** بدون `devMode`، سازنده `Relayer` فقط store با `durable === true` می‌پذیرد (`SqliteRelayerStore` روی فایل؛ نه `MemoryRelayerStore` و نه `:memory:`).
- **ثبت‌نامه ارائه‌دهندگان RPC (`rpcProviders`) — برای relayer و attesterها:** همان ثبت‌نامه در `DeploymentConfig.rpcProviders` (اجباری)، `new Attester(key, chains, routes, verifiers, { rpcProviders })` و `new Relayer(..., { rpcProviders })`. attester با quorum بیشتر از ۱ بدون آن امضا نمی‌کند و gate بررسی می‌کند ثبت‌نامه هر attester در حال اجرا با ثبت‌نامه استقرار یکی باشد.
- **جزئیات ثبت‌نامه:** برای هر ارائه‌دهنده `id`، `operator` (نهاد حقوقی) و originهای دقیق را اعلام کنید، مثلاً `{ id: 'alpha', operator: 'Alpha Inc', origins: ['https://eth-sepolia.alpha.example'] }`. یک origin نباید زیر دو ارائه‌دهنده باشد (سازنده خطا می‌دهد). دو ارائه‌دهنده یک اپراتور، یک رأی‌اند.
- **رد انتقال فقط با اثبات:** برای هر شبکه دست‌کم یک `proofClients` از ارائه‌دهنده‌ای **دیگر** تنظیم کنید (دو اتصال به یک ارائه‌دهنده یک رأی حساب می‌شود). بدون آن، انتقالی که رسیدش پیدا نمی‌شود هرگز خودکار رد نمی‌شود (ایمن، ولی دستی). `checkRelayerRpcs(relayer.runtimeRpcConfig())` و `verifyReadiness(..., { relayer })` سلامت این RPCها را در `operational` گزارش می‌کنند.
- **هشدار «رسید نیست ولی رد نشده»:** critical؛ یعنی RPC اصلی relayer با زنجیره ناسازگار است. RPC را عوض کنید؛ رکورد خودکار ادامه می‌یابد.
- **gate و signer set:** `readinessGate(cfg, clients, { attesters, relayer })` — همه attesterهای signer set باید در حال اجرا باشند؛ حذف یکی gate را می‌بندد.
- **بازیابی دستی (`RECOVERY_REQUIRED`):** ۱) علت را از `history` بخوانید؛ ۲) پیکربندی را از طریق timelock اصلاح کنید؛ ۳) `relayer.recover(id, 'retry_execution' | 're_attest', operatorId, reason)` — فقط اپراتورهای فهرست `operators`، با دلیل اجباری که در تاریخچه ثبت می‌شود. این ابزار فقط جریان عادی را دوباره راه می‌اندازد و هیچ‌گاه خودش وجهی جابه‌جا نمی‌کند. اگر اصلاح ممکن نیست: گیرنده یا timelock پیام را `cancel` کنند ← بازپرداخت خودکار.

## مهاجرت peer یا خزانه (runbook)
1. قرارداد جدید را مستقر و با `verify-deployment` بررسی کنید.
2. از طریق timelock: `setPeer(chain, new)` (یا `setHomeVault(new)`). قبلی خودکار `Draining` می‌شود: پیام‌های در راه آن همچنان اجرا/لغو می‌شوند؛ lock جدید به peer جدید می‌رود.
3. دوره گذار: تا `pendingReport()` هیچ انتقال ناتمامی از peer قدیمی نشان ندهد (و حداقل یک دوره finality + حاشیه).
4. از طریق timelock: `revokePeer(chain, old)` / `revokeVault(old)`. پس از آن هیچ پیامی از آن پذیرفته نمی‌شود و بازگرداندنش ممکن نیست.
5. **peer آسیب‌دیده:** ابتدا فوراً `pauseRoute` (pauser)، سپس لغو؛ انتقال‌های در راه آن عمداً پذیرفته نمی‌شوند و باید جداگانه بررسی شوند.

## Attesterها
- هر attester روی سرور، کلید (HSM/KMS) و **RPC مستقل** خودش اجرا شود.
- سیاست نهایی‌شدن هر شبکه در `protocol/finality.ts` تعریف می‌شود؛ شبکه بدون سیاست صریح امضا نمی‌شود.

## API
- `GET /health`: وضعیت circuit هر ارائه‌دهنده (`closed` / `open` / `half_open`) و اینکه ذخیره‌ساز پایدار فعال است یا نه.
- circuit breaker: پس از `CIRCUIT_FAILURE_THRESHOLD` خطای پیاپی (پیش‌فرض ۵)، ارائه‌دهنده برای `CIRCUIT_COOLDOWN_MS` (پیش‌فرض ۳۰ ثانیه) کنار گذاشته و سپس با یک درخواست آزمایشی بررسی می‌شود. «مسیری وجود ندارد» خطا حساب نمی‌شود.
- هزینه‌ها: گس تراکنش approve فقط وقتی لحاظ می‌شود که allowance واقعی کافی نباشد (با `sender`)؛ بدون `sender` فرض بر نیاز است و برچسب آن این را نشان می‌دهد. اگر قیمت گس در دسترس نباشد، مسیر به REVIEW می‌رود.
- پاسخ همیشه `selection_basis` و `data_as_of` دارد: نتیجه «بهترین خروجی خالص در میان مظنه‌های دریافت‌شده» است، نه تضمین ارزان‌ترین مسیر بازار.

## استقرار (testnet)
1. یک Safe (multisig) روی هر شبکه بسازید (دست‌کم ۲ از ۳، اکثریت مطلق، بدون module). در `governance.multisigPolicy` مالکان، آستانه، آدرس singleton و hash کد proxy را از مخزن رسمی `safe-global/safe-deployments` وارد کنید، و `deployBlock` هر شبکه را ثبت کنید (بلوکی پیش از استقرار نخستین قرارداد؛ gate با RPC آرشیوی بررسی می‌کند که قراردادها پیش از آن کد نداشته‌اند).
2. `script/Deploy.s.sol` با `MULTISIG`، `PAUSER` جدا، `TIMELOCK_DELAY` (≥ ۲ روز پیشنهادی).
3. سیم‌کشی (peer، homeVault، توکن‌ها، rate limitها) را از طریق timelock زمان‌بندی و اجرا کنید.
4. `npx tsx protocol/verify-deployment.ts deployment.json` — تا خروجی `READY FOR TRANSFERS` نباشد، انتقال نپذیرید.
