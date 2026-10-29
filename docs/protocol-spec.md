# مشخصات پروتکل BridgePilot — Lock & Mint با تأیید آستانه‌ای (v1، آزمایشی)

## ۱. مدل
- **شبکه خانه (home):** توکن اصلی در `BridgeVault` قفل می‌شود.
- **شبکه راه دور (remote):** `BridgeExecutor` توکن معادل `BridgeToken` را ضرب و هنگام بازگشت می‌سوزاند.
- **تأیید:** `MessageVerifier` روی هر شبکه؛ پیام زمانی معتبر است که دست‌کم `threshold` امضاکننده فعلی (اکثریت مطلق) آن را امضا کرده باشند.

## ۲. پیام
```
BridgeMessage {
  uint8   version          // = 1
  uint8   kind             // 0 = LOCK_MINT, 1 = BURN_RELEASE, 2 = REFUND
  uint256 sourceChainId
  address sourceContract   // vault یا executor
  uint256 destChainId
  address destContract
  uint256 nonce            // شمارنده خروجی قرارداد مبدأ
  address canonicalToken   // آدرس توکن روی شبکه خانه
  address sender
  address recipient
  uint256 amount           // مقدار خالص (پس از کارمزد)
}
messageId = keccak256(abi.encode(message))
```

## ۳. امضا (EIP-712)
```
domain = { name: "BridgePilot", version: "1", chainId: <شبکه مقصد>, verifyingContract: <MessageVerifier مقصد> }
Attestation(BridgeMessage message, uint64 signerSetVersion)
```
- امضاها باید به ترتیب **صعودی آدرس امضاکننده** ارسال شوند (یکتایی بدون هزینه ذخیره‌سازی).
- `signerSetVersion` با هر چرخش مجموعه امضاکنندگان افزایش می‌یابد؛ امضاهای قدیمی باطل می‌شوند.

## ۴. جریان‌ها
**Lock → Mint**
1. کاربر `vault.lock(token, amount, destChainId, recipient)` را صدا می‌زند؛ کارمزد کسر و `TransferInitiated` منتشر می‌شود.
2. هر attester، پس از نهایی‌شدن طبق **سیاست همان شبکه** (`protocol/finality.ts`)، رسید را از RPC خودش می‌خواند، پیام را از رویداد بازسازی و امضا می‌کند.
3. relayer امضاها را جمع، محلی بررسی و مرتب می‌کند و `executor.execute(message, sigs)` را می‌فرستد.
4. executor: نسخه، نوع، مقصد، مبدأ (=vault خانه)، ثبت توکن، امضاها، replay، rate limit ← `mint`.

**Burn → Release**: معکوس؛ `executor.burn` ← attesterها ← `vault.release` (با بررسی اضافه `amount ≤ lockedFor[token][sourceChain]`). release از هر executorی که زمانی peer بوده پذیرفته می‌شود و غیرفعال‌شدن توکن فقط lock جدید را می‌بندد.

**لغو و بازپرداخت (Cancel → Refund)** — برای انتقالی که در مقصد قابل‌اجرا نیست یا گیرنده آن را نمی‌خواهد:
1. گیرنده (یا مدیر از طریق timelock) `cancel(message, sigs)` را روی قرارداد **مقصد** صدا می‌زند. امضاها اثبات می‌کنند پیام واقعی است. خانه `processed[messageId]` پر و `MessageCancelled` منتشر می‌شود؛ پس از این، اجرا برای همیشه ناممکن است (و برعکس: پیام اجراشده قابل لغو نیست).
2. attesterها پس از نهایی‌شدن رویداد لغو، پیام مشتق‌شده `refundOf(original)` را برای verifier **مبدأ** امضا می‌کنند (kind=2، جهت معکوس، گیرنده = فرستنده اصلی). این نگاشت یک‌به‌یک است.
3. `refund(original, sigs)` روی مبدأ: فقط اگر `initiated[originalId]` (پیام واقعاً همان‌جا آغاز شده و هنوز بازپرداخت نشده)، امضا معتبر، rate limit و پشتوانه کافی باشد. vault مقدار خالص را به فرستنده برمی‌گرداند؛ executor توکن سوزانده‌شده را دوباره به فرستنده ضرب می‌کند.
4. فرستنده به‌تنهایی نمی‌تواند لغو کند (پرداخت‌ها یک‌طرفه برگشت‌پذیر نیستند).
5. **سیاست بازپرداخت:** از سطل محدودیت جداگانه بازیابی (`refundBuckets`) مصرف می‌کند — محدود، ولی هرگز به‌خاطر ترافیک عادی مسدود نمی‌شود؛ اگر سطل خالی باشد بازپرداخت به تأخیر می‌افتد، گم نمی‌شود. توقف یک **مسیر** فقط حرکت رو به جلو (lock/execute/release) را می‌بندد؛ لغو و بازپرداخت ادامه دارند. توقف **سراسری** همه‌چیز را متوقف می‌کند.

**سقف خسارت:** `chainCap[token][chain]` (حداکثر قفل‌شده به سمت یک شبکه) و `supplyCap[token]` (حداکثر عرضه توکن معادل). مقدار تنظیم‌نشده = مسدود.

**چرخه peer و خزانه:** `Active` (پیام‌های جدید) → `Draining` (پس از جایگزینی؛ پیام‌های در راه پذیرفته می‌شوند) → `Revoked` (هیچ پیامی پذیرفته نمی‌شود؛ فقط از Draining، فقط از طریق timelock، غیرقابل بازگشت).

## ۴ب. مدیریت (governance)
- `DEFAULT_ADMIN_ROLE` همه قراردادها = `TimelockController` (حداقل تأخیر پیشنهادی ۲ روز) که تنها proposer و executor آن یک multisig است. deployer هیچ نقشی نگه نمی‌دارد.
- `PAUSER_ROLE` جدا از مدیریت: می‌تواند فوری متوقف کند، اما فقط timelock دوباره راه‌اندازی می‌کند.
- تغییر خزانه (`setHomeVault`) یا peer، پیام‌های در راه را از اعتبار نمی‌اندازد (`knownVault` / `knownPeer`).
- `protocol/verify-deployment.ts` پس از هر استقرار و هر تغییر مدیریتی اجرا می‌شود و تا همه بررسی‌ها پاس نشوند، استقرار «آماده انتقال» نیست.

## ۴ج. افزودن خانواده شبکه
هر شبکه در `PROTOCOL_CHAINS` با `family`، `status` و `finality` ثبت می‌شود. شبکه‌ای که verifier، معیار نهایی‌شدن، شناسه پیام، نگاشت دارایی، اجرای مقصد و بازیابی آن پیاده‌سازی و آزموده نشده، `unsupported` می‌ماند و attesterها برای آن امضا نمی‌کنند. Solana و شبکه‌های UTXO فعلاً پشتیبانی نمی‌شوند؛ هرکدام برنامه/قرارداد، اثبات تراکنش و مدل بازیابی جداگانه لازم دارند و با افزودن یک chain id فعال نمی‌شوند.

## ۵. ماشین حالت انتقال (relayer)
```
CREATED → SOURCE_PENDING → SOURCE_FINALIZED → PROOF_VERIFIED → DESTINATION_PENDING → COMPLETED
فرعی: REJECTED (پایانی), EXPIRED (ادامه‌پذیر؛ پایش ادامه دارد), PAUSED (ادامه‌پذیر), RECOVERY_REQUIRED (دستی؛ هشدار critical),
      CANCELLED → REFUNDED (پایانی)
```
- پیش از ارسال به مقصد، `processed(messageId)` بررسی می‌شود؛ پیام اجراشده هرگز دوباره ارسال نمی‌شود.
- پیش از ارسال، تراکنش شبیه‌سازی می‌شود؛ `EnforcedPause`/`RoutePaused` ← PAUSED، `RateLimitExceeded` ← تلاش مجدد بعدی، بقیه خطاها ← RECOVERY_REQUIRED.
- نبودن رسید از یک RPC **هرگز به‌تنهایی** به REJECTED نمی‌رسد. پس از ۳ بار «not found»، relayer اثبات می‌خواهد: روی دست‌کم ۲ RPC از **اپراتورهای مستقل اعلام‌شده** (`client` + `proofClients`). هویت از ثبت‌نامه صریح `rpcProviders` می‌آید: هر اتصال فقط اگر origin دقیقش (scheme://host:port) زیر دقیقاً یک ارائه‌دهنده اعلام شده باشد شمرده می‌شود؛ استقلال به‌ازای اپراتور شمرده می‌شود، نه دامنه؛ و اپراتورهایی که endpointهایشان به یک IP مشترک resolve شوند (مثل `localhost` و `127.0.0.1`) یکی حساب می‌شوند. بدون ثبت‌نامه، هیچ ردِ خودکاری انجام نمی‌شود، **همه** باید نشان دهند: `initiated(messageId)` در قرارداد مبدأ، هم در یک بلوک نهایی ≥ بلوکی که رویداد در آن دیده شد و هم در latest، `false` است؛ `processed(refundOf(m))` در مبدأ `false` است (یعنی «قفل‌شده و بعداً بازپرداخت‌شده» نیست — آن حالت هم `initiated=false` می‌گذارد)؛ و پیام در مقصد `processed` نشده است. یک RPC صادق کافی است تا رد اشتباه را متوقف کند. بدون این اثبات، رکورد در همان حالت (`SOURCE_PENDING`/`EXPIRED`) پایش می‌شود و یک هشدار critical می‌گیرد. خطای RPC فقط تلاش مجدد است. اگر همان پیام دوباره در زنجیره ظاهر شود، relayer آن را از نو می‌پذیرد. رکوردها با hash کامل پیام کلید می‌شوند، نه nonce.
- امضاهای منقضی (چرخش مجموعه امضاکنندگان) ← بازگشت به SOURCE_FINALIZED و امضای مجدد.
- COMPLETED فقط پس از نهایی‌شدن در مقصد (طبق سیاست همان شبکه) و `processed()=true`؛ تراکنش گم‌شده پس از timeout دوباره شبیه‌سازی می‌شود.
- اگر در هر حالت پیش از اجرا `processed()=true` و `cancelled()=true` باشد ← CANCELLED و بازپرداخت خودکار.
- همه رکوردها و checkpointهای اسکن پس از هر گام در SQLite ذخیره می‌شوند؛ پس از restart دقیقاً از همان‌جا ادامه می‌دهد.
- `EXPIRED` پایانی نیست: مهلت عادی گذشته ولی پایش ادامه دارد؛ با نهایی‌شدن ← `SOURCE_FINALIZED`؛ با اثبات حذف تراکنش ← `REJECTED`.
- `REJECTED` فقط وقتی ثابت شود چیزی قفل نشده (همان اثبات بالا، حتی وقتی همه attesterها می‌گویند «تراکنش revert شده/رویداد نیست»)؛ اگر attesterها رد کنند ولی اثبات کامل نشود ← `RECOVERY_REQUIRED`؛ خطاهای پیکربندی/داده ← `RECOVERY_REQUIRED`.
- **write-ahead:** تراکنش مقصد/بازپرداخت امضا و hash و متن آن پیش از ارسال ذخیره می‌شود؛ پس از crash همان تراکنش (همان nonce) دوباره ارسال می‌شود. چون تراکنش امضاشده ممکن است بلوک‌ها بعد وارد زنجیره شود و هزینه نوشتن در storage به وضعیت بستگی دارد، gas با حاشیه (۱۳۰٪ تخمین + ۳۰٬۰۰۰) امضا می‌شود؛ بدون این حاشیه، در آزمون‌های تکراری حدود یک در بیست اجرا تراکنش ذخیره‌شده out-of-gas می‌شد.
- **مدرک اجرا:** رویداد `TransferCompleted`/`TransferReleased`/`TransferRefunded` در رسید نهایی، مستقل از خواندن احتمالاً کهنه `processed`.
- **lease:** هر رکورد فقط توسط نمونه‌ای پردازش می‌شود که lease آن را دارد، پس از بارگذاری آخرین وضعیت.
- **gate (اجباری در کد):** تا `verifyReadiness` (استقرار + attesterهای در حال اجرا) موفق نباشد، ریلیر هیچ تراکنش رو به جلویی نمی‌فرستد؛ بازپرداخت‌ها ادامه دارند. توقف مسیر جزو gate نیست.
- **هم‌روندی:** تمدید lease در طول گام، بررسی دوباره lease پیش از ارسال، و ذخیره نسخه‌دار (CAS) که نوشتن وضعیت قدیمی روی وضعیت جدید را ناممکن می‌کند.
- هشدار: `RECOVERY_REQUIRED` ← critical؛ ماندن بیش از `stuckAfterMs` در یک حالت ← warning؛ `pendingReport()` برای داشبورد.

## ۶. ثابت‌های امنیتی (invariant) که آزموده می‌شوند
1. `balanceOf(vault) == totalLocked + accruedFees`، و `totalLocked == Σ lockedFor[token][remoteChain]`
2. `wrapped.totalSupply ≤ lockedFor[token][remote]` (پشتوانه به‌ازای هر شبکه راه دور)
3. `totalLocked == wrapped.totalSupply + Σ pendingMints + Σ pendingReleases + Σ cancelledLocks + Σ cancelledBurns`
4. هیچ replay و هیچ جعلی (یک امضای معتبر + یک کلید بیرونی) موفق نمی‌شود.
5. هیچ پرداخت دوگانه‌ای (اجرای پیام لغوشده، بازپرداخت پیام اجراشده، بازپرداخت دوباره) موفق نمی‌شود.

## ۷. پارامترهای مدیریتی
| پارامتر | قرارداد | محدودیت |
|---|---|---|
| `feeBps` | Vault | ≤ ۱۰۰ (۱٪، تغییرناپذیر) |
| token config (min/max) | Vault | min > 0 |
| rate limit (capacity/window) | Vault, Executor | بدون تنظیم = مسدود |
| peers / homeVault | Vault, Executor | فقط admin (timelock)؛ مقادیر قبلی برای پیام‌های در راه معتبر می‌مانند |
| مجموعه امضاکنندگان | Verifier | مرتب، یکتا، ≤ ۳۲، اکثریت مطلق، با تأخیر ≥ ۱ روز |
| pause | همه | pauser متوقف می‌کند، فقط admin ادامه می‌دهد |
