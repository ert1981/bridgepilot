# مدل تهدید BridgePilot (نسخه آزمایشی)

> وضعیت: **فقط شبکه آزمایشی**. قراردادها در سازنده خود روی شبکه‌های اصلی شناخته‌شده (Ethereum، Base، Arbitrum، Optimism، Polygon و …) revert می‌کنند. این سند جایگزین ممیزی مستقل نیست.

## ۱. دارایی‌های در معرض خطر

| دارایی | محل | پیامد از دست رفتن |
|---|---|---|
| توکن‌های قفل‌شده | `BridgeVault` روی شبکه خانه | سرقت مستقیم وجوه کاربران |
| توکن معادل (`BridgeToken`) | شبکه مقصد | ضرب بدون پشتوانه ← بی‌ارزش‌شدن توکن معادل |
| کلیدهای امضاکنندگان (attester) | سرورهای جدا | جعل پیام در صورت تبانی آستانه |
| کلید مدیر (admin) | multisig پیشنهادی | تغییر peer، توکن، محدودیت‌ها |
| کلید pauser | ربات پایش | توقف سرویس (نه سرقت) |
| کلید relayer | سرور relayer | فقط هزینه گس؛ قدرت جعل ندارد |

## ۲. مرزهای اعتماد

- **امضاکنندگان (M-of-N):** مدل امنیتی این نسخه مبتنی بر اعتماد است. اگر `threshold` امضاکننده تبانی کنند یا کلیدشان دزدیده شود، می‌توانند پیام جعلی بسازند.
- **Relayer:** کاملاً غیرقابل‌اعتماد فرض شده. نمی‌تواند امضا جعل کند؛ قرارداد مقصد همه‌چیز را دوباره بررسی می‌کند. بدترین اثر: تأخیر.
- **RPC:** هر attester باید RPC مستقل خودش را داشته باشد؛ RPC مشترک یک نقطه شکست مشترک است.
- **API مسیریابی:** ارائه‌دهندگان (LI.FI، Across) غیرقابل‌اعتمادند؛ هر مظنه و تراکنش آن‌ها به‌طور مستقل اعتبارسنجی می‌شود.

## ۳. سناریوهای حمله و کنترل‌ها

| # | حمله | کنترل | آزمون |
|---|---|---|---|
| T1 | تکرار پیام (replay) روی همان قرارداد | `ReplayProtection.processed[messageId]` پیش از هر تعامل خارجی | `test_replayMintReverts`, `test_replayReleaseReverts`, invariant `noReplayEverSucceeds`, e2e idempotency |
| T2 | تکرار امضا روی شبکه یا قرارداد دیگر | دامنه EIP-712 شامل `chainId` و آدرس verifier؛ پیام شامل `destChainId` و `destContract` | `test_signaturesAreDomainSeparatedPerChainAndVerifier`, `test_wrongDestinationAndSourceRevert` |
| T3 | سردرگمی نوع پیام (lock به‌جای burn) | فیلد `kind` امضا می‌شود و هر قرارداد فقط یک نوع می‌پذیرد | `test_kindConfusionReverts` |
| T4 | دست‌کاری هر فیلد پیام | همه ۱۱ فیلد در struct hash | `testFuzz_anyFieldTamperIsRejected` (۱۰۰۰ اجرا) |
| T5 | یک امضاکننده دزدیده‌شده | آستانه اکثریت مطلق (`threshold > n/2`) | `test_belowThresholdReverts`, e2e «single compromised attester» |
| T6 | امضای تکراری یا شکل‌پذیر | امضاها باید به ترتیب صعودی آدرس باشند؛ `ECDSA.tryRecover` با رد s بالا | `test_duplicateSignerReverts`, `test_unsortedSignaturesRevert`, `testFuzz_randomSignaturesRejected` |
| T7 | جعل رویداد مبدأ / reorg | attester رسید را از RPC خودش می‌خواند، `confirmations` بلوک صبر می‌کند، تطبیق hash بلوک canonical | e2e «reorged lock is never attested» |
| T8 | پیام اعلامی relayer با رویداد زنجیره فرق دارد | attester پیام را از رسید زنجیره بازسازی و مقایسه می‌کند | e2e «attesters refuse a message that differs» |
| T9 | آزادسازی بدون پشتوانه حتی با امضای معتبر | `release` هرگز بیش از `lockedFor[token][sourceChain]` آزاد نمی‌کند؛ پشتوانه **به‌ازای هر شبکه راه دور** جداست، پس نفوذ به یک شبکه پشتوانه شبکه‌های دیگر را تخلیه نمی‌کند | `test_releaseCannotExceedBackingEvenIfAttestersSign`, `test_backingIsIsolatedPerRemoteChain`, invariants `wrappedSupplyIsBacked`, `perChainBackingMatchesTotal` |
| T10 | خالی‌کردن خزانه توسط مدیر | هیچ تابع sweep وجود ندارد؛ فقط `accruedFees` برداشت‌پذیر است | `test_adminCannotWithdrawLockedFunds`, invariant `vaultAccountingIsExact` |
| T11 | توکن fee-on-transfer یا rebasing | مقایسه موجودی قبل/بعد (fee-on-transfer)؛ **بررسی توان پرداخت** `balance ≥ totalLocked + fees` پس از هر تغییر وضعیت، تا rebase منفی توکن را متوقف کند نه اینکه حسابداری را از واقعیت جدا کند؛ فقط توکن‌های بررسی‌شده و allowlist — پشتیبانی عمومی از هر ERC-20 ادعا نمی‌شود | `test_rejectsFeeOnTransferToken`, `test_negativeRebaseHaltsTokenInsteadOfMisAccounting` |
| T12 | تخلیه سریع پس از نفوذ | rate limit به‌ازای توکن (token bucket)، fail-closed اگر تنظیم نشده | `test_rateLimitBlocksAndRefills`, `testFuzz_rateLimitBound`, `test_unconfiguredRateLimitFailsClosed` |
| T13 | جابه‌جایی فوری مجموعه امضاکنندگان | تأخیر زمانی با کف ۱ روز (`MIN_ROTATION_DELAY`) + ابطال امضاهای قدیمی با `signerSetVersion`؛ relayer پس از چرخش دوباره امضا می‌گیرد | `test_signerRotationIsDelayedAndInvalidatesOldSignatures`, `test_rotationDelayHasFloor`, e2e «re-attests after rotation» |
| T13b | مدیر با غیرفعال‌کردن توکن، تغییر peer یا تغییر خزانه وجوه در راه را مسدود کند | `enabled` فقط lock را محدود می‌کند؛ هر peer قبلی (`knownPeer`) و هر خزانه قبلی (`knownVault`) برای پیام‌های در راه معتبر می‌ماند؛ قطع فقط با pause مسیر | `test_disablingTokenOrChangingPeerNeverFreezesPendingReleases`, `test_inFlightLocksSurviveHomeVaultMigration` |
| T13c | سوءاستفاده از کلید مدیر | `DEFAULT_ADMIN_ROLE` = `TimelockController` که تنها proposer/executor آن یک multisig (قرارداد) است؛ deployer هیچ نقشی نگه نمی‌دارد؛ pauser جدا از مدیریت؛ `verify-deployment.ts` در غیر این صورت «آماده» اعلام نمی‌کند | `test_adminActionsGoThroughTimelock`, e2e «deployment verifier» |
| T13d | گیرکردن دائمی وجوه | **لغو + بازپرداخت**: گیرنده (یا مدیر از طریق timelock) پیام را در مقصد `cancel` می‌کند؛ لغو و اجرا یک خانه `processed[]` مشترک دارند پس فقط یکی ممکن است؛ attesterها پس از نهایی‌شدن رویداد `MessageCancelled` پیام `refundOf(original)` را امضا می‌کنند؛ مبدأ فقط پیامی را که واقعاً همان‌جا آغاز شده (`initiated`) و یک‌بار بازپرداخت می‌کند | `test_stuckLockIsCancelledThenRefundedOnce`, `test_noDoublePay_*`, `test_cancelledBurnIsReMintedToSender`, invariant `noDoublePayEver`, e2e «stuck transfer … refunded exactly once» |
| T14 | reentrancy | `nonReentrant` + checks-effects-interactions | بازبینی کد |
| T15 | استقرار اشتباه روی mainnet | `TestnetOnly` حالا **allowlist** صریح شبکه‌های آزمایشی است (هر شبکه دیگری، از جمله mainnetهای آینده، رد می‌شود) + بررسی وجود کد verifier در سازنده | `test_mainnetDeploymentBlocked`, `testFuzz_onlyAllowlistedTestnetsDeploy`, `test_constructorsRejectMissingVerifier` |
| T16 | مظنه یا تراکنش دست‌کاری‌شده از API ارائه‌دهنده | allowlist قرارداد هدف، تطبیق chainId، مقدار native، from، approval دقیق؛ **رمزگشایی calldata** (LI.FI `BridgeData` / Across `depositV3`) و تطبیق گیرنده، شبکه مقصد، توکن و مقدار؛ رد destination call؛ calldata ناشناخته = رد | `tests/api.test.ts` — «refuses tampered execution data» (۱۰ حالت) |
| T16b | ارائه‌دهنده قیمت مظنه خودش را تعیین کند | قیمت فقط از داده بازار مستقل یا peg علامت‌دار؛ قیمت‌های ارائه‌دهنده فقط به‌صورت میانه، برای کل درخواست، و با وضعیت REVIEW؛ هیچ ذخیره بین درخواست‌ها | `tests/orchestrator.test.ts` — H2 |
| T17 | دور زدن پرداخت x402 / پرداخت تکراری | رزرو **اتمیک** nonce پیش از فراخوانی facilitator در ذخیره‌ساز مشترک (SQLite با `INSERT OR IGNORE`) — بین چند فرایند و پس از restart معتبر؛ نگهداری تا `validBefore` + یک ساعت؛ settle فقط پس از موفقیت | `tests/api.test.ts` — «shared atomically across API instances» |
| T19 | نهایی‌شدن نادرست روی L2 | سیاست نهایی‌شدن **به‌ازای هر شبکه**: برای testnetها تگ `finalized` RPC (روی OP/Arbitrum یعنی batch نهایی‌شده روی L1)؛ `depth` فقط برای شبکه محلی؛ شبکه بدون سیاست صریح = پشتیبانی‌نشده | `tests/protocol-unit.test.ts` — finality |
| T20 | restart ریلیر و از دست رفتن وضعیت | رکوردها و checkpoint اسکن در SQLite پس از هر گام ذخیره می‌شوند؛ اسکن مجدد با حاشیه reorg؛ idempotency با `processed()` روی زنجیره | e2e «survives a relayer crash and restart» |
| T21 | گیرکردن دائمی پس از انقضای مهلت | `EXPIRED` پایانی نیست: پایش ادامه دارد، با نهایی‌شدن دیر به مسیر عادی برمی‌گردد؛ `REJECTED` فقط وقتی همه attesterها ثابت کنند چیزی قفل نشده (تراکنش revert یا بدون رویداد)؛ خطای پیکربندی ← `RECOVERY_REQUIRED`؛ گذشت زمان هرگز مجوز بازپرداخت نیست | e2e «EXPIRED is not terminal», unit «EXPIRED is recoverable» |
| T22 | پر بودن rate limit مانع بازپرداخت | سطل جداگانه بازیابی (`refundBuckets`)؛ بازپرداخت محدود است ولی ترافیک عادی آن را مسدود نمی‌کند؛ توقف مسیر بازپرداخت را نگه می‌دارد، توقف سراسری متوقف می‌کند | `test_refundWorksWhenTransferBucketIsExhausted`, `test_refundsAreStillBoundedByTheRecoveryLimit`, `test_routePausePreservesCancelAndRefund_globalPauseStopsThem` |
| T23 | خسارت نامحدود با تبانی امضاکنندگان | سقف خسارت هر شبکه: `chainCap` در vault و `supplyCap` در executor (fail-closed) | `test_chainCapBoundsLocksTowardsOneChain`, `test_supplyCapBoundsForgedMintsEvenWithValidSignatures`, invariant `capsAreNeverExceeded` |
| T24 | peer/خزانه قدیمی پس از مهاجرت | چرخه Active → Draining → Revoked؛ فقط Draining قابل لغو است؛ Revoked هرگز برنمی‌گردد | `test_peerMigrationDrainThenRevoke`, `test_vaultMigrationDrainThenRevokeOnExecutor` |
| T25 | دو ریلیر هم‌زمان / crash بین ارسال و ذخیره / RPC کهنه | lease برای هر رکورد؛ write-ahead (امضا و ذخیره hash پیش از ارسال، ارسال دوباره همان تراکنش)؛ رویداد اجرا در رسید نهایی مدرک است، نه خواندن `processed` | e2e «two relayers», «crash after persisting», «stale processed()» |
| T26 | توقف یک مسیر کل پردازش (و بازپرداخت‌ها) را متوقف کند | توقف مسیر/سراسری «عملیاتی» است و gate را نمی‌بندد؛ gate بسته فقط ارسال رو به جلو را نگه می‌دارد | e2e «route pause … still refunded», «closed readiness gate … refund still completes» |
| T27 | اجرای ریلیر بدون بررسی آمادگی | ساخت Relayer بدون gate خطا می‌دهد؛ `devMode` فقط روی شبکه‌های محلی | e2e «cannot be built without a gate» |
| T28 | پیکربندی اعلام‌شده با attester در حال اجرا فرق کند | gate attesterهای واقعی را بررسی می‌کند: اتصال آدرس به اعلام، quorum عملیاتی ≥ ۲، endpoint از ارائه‌دهندگان متمایز و اعلام‌شده، probe سلامت finality هر endpoint | e2e «gate checks the RUNNING attesters», unit «gate probes every endpoint» |
| T29 | گام کندتر از TTL lease | تمدید lease، بررسی پیش از ارسال، ذخیره CAS | e2e «slower than the lease TTL» (با و بدون تمدید؛ فرستنده تراکنش بررسی می‌شود) |
| T30 | سقف خسارت فقط مثبت بودن را بررسی کند | `maxChainCap` و `reactionTimeSec` اجباری؛ سقف‌ها و بدترین خروجی هر سطل پیش از واکنش با آن مقایسه می‌شوند | e2e «Damage policy is mandatory», unit «worst-case outflow» |
| T18 | خطای موقت RPC یا reorg در مقصد | relayer فقط «not found» مکرر (۳ بار) را reorg می‌داند؛ COMPLETED فقط پس از عمق تأیید در مقصد و `processed()=true`؛ تراکنش گم‌شده پس از timeout دوباره شبیه‌سازی می‌شود | e2e «transient RPC errors», «reorged lock» |

### بازبینی چهارم (T31–T35)

| # | تهدید | کنترل | آزمون |
|---|---|---|---|
| T31 | RPC عقب‌مانده یا دروغگو رسید یک lock واقعی را برنمی‌گرداند ← رد اشتباه و گیر کردن وجه | رد فقط با اثبات `initiated(id)=false` در بلوک نهایی و latest روی ≥ ۲ RPC مستقل؛ در غیر این صورت پایش + هشدار critical | e2e: «a real, final lock whose receipt one RPC cannot find is NEVER rejected» |
| T32 | attesterهای در حال اجرا با signer set قرارداد یکی نیستند (کم، اضافه، تکراری) ← gate باز ولی انتقال‌ها متوقف | مقایسه دقیق مجموعه در حال اجرا و اعلام‌شده با `signers()` هر شبکه؛ تعداد ≥ threshold | unit + e2e (حذف یک attester، کلید ناشناس، تکرار) |
| T33 | endpoint اعلام‌شده با اتصال واقعی یکی نیست | هر عضو quorum یک جفت (endpoint, client) است و endpoint از transport خود client خوانده می‌شود؛ هویت نامعلوم = خطا؛ RPCهای relayer در سلامت عملیاتی | unit + e2e |
| T34 | relayer تولیدی با ذخیره‌ساز حافظه (از دست رفتن write-ahead پس از restart) | سازنده بدون store پایدار (`durable`) خطا می‌دهد، مگر devMode روی شبکه محلی | e2e |
| T35 | multisig جعلی یا ضعیف، admin ناشناخته، تأخیر timelock کوتاه با پیکربندی | بررسی Safe؛ بازسازی همه دارندگان نقش از رویدادهای `RoleGranted`/`RoleRevoked` و تطبیق با `hasRole`؛ کف پروژه ۲ روز | e2e (admin پنهان، module، 1-of-1، تأخیر ۱ روز، deployBlock اشتباه) |

### بازبینی پنجم (T36–T39)

| # | تهدید | کنترل | آزمون |
|---|---|---|---|
| T36 | اثبات «قفل نشده» با دو اتصال به یک ارائه‌دهنده | `proveNotLocked` خودش ارائه‌دهنده‌های متمایز را از transport هر اتصال می‌شمارد؛ هویت نامعلوم = بدون اثبات | e2e «two connections to the SAME provider …» |
| T37 | انتقال بازپرداخت‌شده (`initiated=false`) پس از ازدست‌رفتن وضعیت «هرگز قفل نشده» تلقی شود | اثبات همچنین `processed(refundOf(m))=false` در مبدأ و `processed(id)=false` در مقصد را لازم دارد | e2e «locked and later REFUNDED …» (با حذف این شرط، آزمون شکست می‌خورد) |
| T38 | `deployBlock` دیرتر از اعطای نقش ← admin پنهان بیرون از تاریخچه | gate بررسی می‌کند هر قرارداد نقش‌دار در بلوک `deployBlock − 1` کد نداشته (RPC آرشیوی لازم)؛ پس هیچ اعطایی پیش از تاریخچه ممکن نیست | e2e (admin اعطاشده پیش از deployBlock دیر) |
| T39 | `test:3x` بدون Foundry سبز شود | بدون forge/anvil اجرا شکست می‌خورد؛ هر تست skip‌شده = شکست؛ `--app-only` صراحتاً «قرارداد و e2e اجرا نشد» اعلام و `complete: false` ثبت می‌کند | اجرای دستی با `FORGE_PATH=/nonexistent` |

### بازبینی ششم (T40–T42)

| # | تهدید | کنترل | آزمون |
|---|---|---|---|
| T40 | دو نام/دامنه برای یک نود یا یک اپراتور، «دو ارائه‌دهنده مستقل» شمرده شوند | ثبت‌نامه صریح `rpcProviders` (origin دقیق ← ارائه‌دهنده ← اپراتور)؛ اتصال ناشناخته شمرده نمی‌شود؛ اپراتورهای با IP مشترک ادغام می‌شوند؛ اعتبارسنجی ثبت‌نامه در سازنده | unit (عملگر/دامنه/پورت/DNS)، e2e «name alias … merged by shared IP» |
| T41 | شکست `forge build` گزارش موفق قبلی را باقی بگذارد | گزارش در آغاز هر اجرا با `status: running` جایگزین می‌شود؛ همه مسیرهای خروج گزارش `failed` می‌نویسند | اجرای دستی با forge جعلی که build را رد می‌کند |
| T42 | ادعای اجرای مکرر e2e قابل تأیید نیست | `e2e_stability` در گزارش: تعداد درخواستی/اجراشده، شناسه، زمان، نتیجه و نام تست‌های ناموفق هر اجرا | خود گزارش |

| T43 | RPCهای attester (دو دامنه با IP متفاوت از یک شرکت) دو رأی مستقل شمرده شوند | همان ثبت‌نامه برای attesterها: `DeploymentConfig.rpcProviders` اجباری؛ بررسی ایستا و gate استقلال را به‌ازای اپراتور اعلام‌شده می‌شمارند؛ خود `Attester` با quorum > 1 بدون ثبت‌نامه امضا نمی‌کند و توافق را به‌ازای اپراتور می‌شمارد؛ ثبت‌نامه attester در حال اجرا باید با ثبت‌نامه استقرار یکی باشد | unit + e2e «one company, different IPs», «attester RPC quorum …» |

**محدودیت صریح:** نرم‌افزار نمی‌تواند ثابت کند دو اپراتور اعلام‌شده واقعاً دو شرکت مستقل با زیرساخت جدا هستند؛ فقط اعلام صریح، اتصال دقیق و نبودِ IP مشترک را اعمال می‌کند. استقلال قراردادی و زیرساختی ارائه‌دهندگان بخشی از ممیزی عملیاتی است. در آزمون‌ها، `127.0.0.2` جایگزین یک endpoint مستقل است (همان نود محلی، IP متمایز).

### مسیر ارتقای verifier (T44–T47)

| # | تهدید | کنترل | آزمون |
|---|---|---|---|
| T44 | حاکمیت verifier امن را با verifier ضعیف‌تر جایگزین کند | `VerifierRouter`: سطح پیشنهادی ≥ سطح فعال و کمینه مسیر؛ کمینه فقط بالا می‌رود؛ تابع کاهش وجود ندارد | forge `test_noDowngradeEver`، fuzz `testFuzz_levelNeverDecreases`، e2e «upgrade path» |
| T45 | جایگزینی بی‌سروصدا یا فوری | پیشنهاد عمومی + تأخیر ≥ ۷ روز (ثابت قرارداد) + فعال‌سازی فقط پس از آن؛ وتوی guardian؛ تاریخچه روی زنجیره؛ پیشنهاد معلق در گزارش عملیاتی | forge `test_upgradeNeedsDelay…`، `test_guardianCanVeto…` |
| T46 | verifier پس از پیشنهاد (یا فعال‌سازی) کد/سطحش را عوض کند | codehash و سطح در فعال‌سازی دوباره بررسی می‌شوند؛ `verify` سطح کمتر از کمینه را رد می‌کند | forge `test_verifierThatChangesItsLevelIsRefused` |
| T47 | verifier ممیزی‌نشده فعال یا زمان‌بندی شود | gate: codehash فعال و پیشنهاد معلق باید در `verifierPolicy.allowedCodeHashes` باشند؛ در غیر این صورت gate بسته | e2e «upgrade path» |

**محدودیت:** سطح امنیتی را خود verifier اعلام می‌کند؛ ratchet جلوی کاهش سطح اعلام‌شده را می‌گیرد، نه جلوی verifierی که دروغ بگوید. دفاع: تأخیر، وتو، allowlist کد ممیزی‌شده.

### آزمون جهش (mutation)

`npm run test:mutation` (`scripts/mutation-check.sh`) هر کنترل امنیتی اصلی را یکی‌یکی عمداً خراب می‌کند و بررسی می‌کند که آزمون‌ها شکست بخورند؛ نتیجه در `mutation-report.txt`. این بررسی یک شکاف را پیدا کرد: حذف بررسی دوباره lease پیش از ارسال با هیچ آزمونی کشف نمی‌شد، چون در آزمون مسابقه موجود، CAS نسخه هم جلوی ارسال دوم را می‌گرفت. آزمون جدید سناریویی را می‌سازد که در آن **فقط** lease مانع است (نمونه دیگر lease را گرفته ولی هنوز چیزی ننوشته) — T48.

## ۴. ریسک‌های باقی‌مانده (پذیرفته‌شده در این نسخه)

1. **اعتماد به امضاکنندگان (ریسک اصلی، حل‌نشده) — جزئیات در [`trust-model.md`](trust-model.md):** این پروتکل اثبات رمزنگاری‌شده یا light client ندارد. تبانی یا نفوذ به `threshold` امضاکننده می‌تواند پیام جعلی بسازد — از جمله بازپرداخت جعلی برای پیامی که در مقصد اجرا شده — تا سقف `chainCap`/`supplyCap` همان شبکه و با سرعت محدود به rate limitها. کاهش‌ها فقط آسیب را محدود می‌کنند، حذف نمی‌کنند: اپراتورهای واقعاً مستقل، کلید در HSM/KMS، RPC مستقل برای هر attester، سقف کم، پایش و توقف اضطراری. این یک مدل **اعتمادمحور** است.
2. **غیرقابل‌برگشت بودن lock پیش از لغو:** فرستنده به‌تنهایی نمی‌تواند انتقال را پس بگیرد (عمداً، تا پرداخت‌ها قابل‌برگشت یک‌طرفه نباشند). اگر گیرنده قراردادی بدون امکان فراخوانی `cancel` باشد، فقط مدیر (با تأخیر timelock) می‌تواند لغو کند. کارمزد پروتکل بازپرداخت نمی‌شود.
3. **multisig:** gate آن را به‌عنوان Safe بررسی می‌کند (کد proxy و singleton مجاز، مالکان و آستانه برابر سیاست، کف ۲ از ۳ و اکثریت مطلق، بدون module). اما استقلال واقعی مالکان و امنیت کلیدهایشان را نمی‌تواند از روی زنجیره ثابت کند؛ این بخشی از ممیزی عملیاتی است. آزمون‌ها از یک stand-in (`MockSafe`) استفاده می‌کنند که فقط رابط خواندنی Safe را دارد.
4. **finality روی شبکه‌هایی که تگ `finalized` را درست پیاده نکرده‌اند:** فرض بر درستی RPC است؛ attesterها باید RPC مستقل و معتبر داشته باشند.
5. **چند میزبان:** ذخیره‌ساز SQLite برای چند فرایند روی یک میزبان امن است؛ برای چند سرور باید رابط‌های `Store`/`NonceStore`/`RelayerStore` روی PostgreSQL پیاده شوند (`docs/operations.md`).
6. **قراردادها ممیزی نشده‌اند.** آزمون‌های fuzz و invariant جایگزین ممیزی مستقل نیستند. پیش از هر دارایی واقعی، ممیزی و برنامه پاسخ به حادثه لازم است.
