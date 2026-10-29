/**
 * /register-onchain: static page where the tool creator registers BridgePilot's quote tool in the
 * ERC-8257 ToolRegistry on Base, signing with their OWN browser wallet (EIP-1193: MetaMask, Coinbase
 * Wallet, ...). The server never sees a key and the page contains no secrets: only public constants
 * (registry address, metadata URI, the JCS keccak256 hash of the live manifest, the creator address).
 */
import { createHash } from 'node:crypto';
import { encodeFunctionData } from 'viem';
import type { AppConfig } from '../../src/config/env.js';
import { buildToolManifest, MANIFEST_PATH, manifestHash, manifestStatus } from './opensea-tool.js';

export const CHAIN_ID = 8453; // Base mainnet
export const REGISTRY = '0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1'; // canonical ToolRegistry (@opensea/tool-sdk 0.31.1)
export const NO_PREDICATE = '0x0000000000000000000000000000000000000000'; // open access: payment is enforced by x402
export const REGISTER_SELECTOR = '0xfe1d0b16'; // registerTool(string,bytes32,address)
/** keccak256("ToolRegistered(uint256,address,address,string,bytes32)") */
export const TOOL_REGISTERED_TOPIC = '0xe7be7fd3c802f61682f56ba817276b1cc81fbee7cb50705c8ed7952811dac397';

const REGISTER_ABI = [{
  type: 'function', name: 'registerTool', stateMutability: 'nonpayable',
  inputs: [{ name: 'metadataURI', type: 'string' }, { name: 'manifestHash', type: 'bytes32' }, { name: 'accessPredicate', type: 'address' }],
  outputs: [{ name: 'toolId', type: 'uint256' }],
}] as const;

export interface RegisterTx { metadataURI: string; manifestHash: `0x${string}`; creator: string; to: string; data: `0x${string}` }

export function registerTx(cfg: AppConfig): RegisterTx {
  const m = buildToolManifest(cfg);
  const st = manifestStatus(cfg);
  if (!st.ok) throw new Error(st.reason);
  const metadataURI = `${st.base}${MANIFEST_PATH}`;
  const hash = manifestHash(m);
  const data = encodeFunctionData({ abi: REGISTER_ABI, functionName: 'registerTool', args: [metadataURI, hash, NO_PREDICATE] });
  return { metadataURI, manifestHash: hash, creator: st.creator, to: REGISTRY, data };
}

const SCRIPT = String.raw`
"use strict";
const T = JSON.parse(document.getElementById("tx").textContent);
const CHAIN_HEX = "0x2105";
const $ = (id) => document.getElementById(id);
const eth = window.ethereum;
let account = null, chainOk = false, dup = null;
const LS = "bridgepilot-reg-" + T.manifestHash;
const txLink = (h) => '<a target="_blank" rel="noopener" href="https://basescan.org/tx/' + h + '">' + h + "</a>";
const toolLink = (id) => '<a target="_blank" rel="noopener" href="https://opensea.io/tools/erc8257/base/' + id + '">opensea.io/tools/erc8257/base/' + id + "</a>";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function fmtEth(wei){ return (Number(wei) / 1e18).toFixed(9); }
function decodeUri(data){
  try { const h = data.slice(2); const off = parseInt(h.slice(0, 64), 16) * 2; const len = parseInt(h.slice(off, off + 64), 16);
    const bytes = h.slice(off + 64, off + 64 + len * 2); let s = ""; for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
    return decodeURIComponent(escape(s)); } catch (e) { return null; }
}
async function checkDuplicate(){
  const el = $("dup");
  try {
    const topic = "0x" + T.creator.slice(2).toLowerCase().padStart(64, "0");
    const logs = await eth.request({ method: "eth_getLogs", params: [{ address: T.to, fromBlock: "0x0", toBlock: "latest", topics: [T.topic, null, topic] }] });
    const same = logs.filter((l) => decodeUri(l.data) === T.metadataURI);
    if (same.length) { dup = BigInt(same[same.length - 1].topics[1]).toString();
      el.innerHTML = '<span class="warn">این ابزار قبلاً ثبت شده است: Tool #' + dup + " · Already registered as Tool #" + dup + "</span><br>" + toolLink(dup);
    } else el.innerHTML = '<span class="ok">ثبت قبلی برای این آدرس پیدا نشد · No earlier registration of this URL found</span>';
  } catch (e) { el.innerHTML = '<small class="warn">بررسی ثبت تکراری ممکن نشد؛ پیش از ثبت، صفحه‌ی ابزارها در OpenSea را نگاه کن · Could not check for duplicates (' + esc(e && e.message || e) + ")</small>"; }
}
async function refresh(){
  if (!eth) return;
  account = (await eth.request({ method: "eth_accounts" }))[0] || null;
  const chainId = await eth.request({ method: "eth_chainId" });
  chainOk = String(chainId).toLowerCase() === CHAIN_HEX;
  $("switch").disabled = !account || chainOk;
  let s = account ? "حساب · Account: " + esc(account) : "وصل نیست · Not connected";
  s += "<br>شبکه · Network: " + (chainOk ? '<span class="ok">Base ✓</span>' : '<span class="warn">' + esc(chainId) + " (not Base)</span>");
  if (account && chainOk) {
    try { const bal = BigInt(await eth.request({ method: "eth_getBalance", params: [account, "latest"] }));
      s += "<br>موجودی · Balance: " + fmtEth(bal) + " ETH" + (bal === 0n ? ' <span class="err">— برای گس کمی ETH روی Base لازم است · you need a little ETH on Base</span>' : "");
    } catch (e) {}
  }
  $("status").innerHTML = s;
  const mismatch = account && account.toLowerCase() !== T.creator.toLowerCase();
  $("acctWarn").innerHTML = mismatch ? "هشدار: این حساب با سازنده‌ی مانیفست (" + T.creator + ") یکی نیست.<br><span class='en'>Connected account differs from the manifest creator; OpenSea would reject the listing.</span>" : "";
  const ready = account && chainOk && !mismatch;
  $("register").disabled = !ready;
  if (ready) { checkDuplicate(); estimate(); }
}
async function estimate(){
  try { const [gas, price] = await Promise.all([eth.request({ method: "eth_estimateGas", params: [{ from: account, to: T.to, data: T.data }] }), eth.request({ method: "eth_gasPrice" })]);
    $("est").innerHTML = "<small>Estimated gas: " + BigInt(gas) + " × " + (Number(BigInt(price)) / 1e9).toFixed(4) + " gwei ≈ " + fmtEth(BigInt(gas) * BigInt(price)) + " ETH (+ tiny L1 data fee)</small>";
  } catch (e) { $("est").innerHTML = '<small class="err">Simulation failed: ' + esc(e && e.message || e) + "</small>"; }
}
async function register(){
  const res = $("res");
  if ((dup || localStorage.getItem(LS)) && !confirm("این ابزار قبلاً ثبت/ارسال شده. ثبت دوباره یک ابزار تکراری می‌سازد. ادامه؟\nAlready registered or sent. Registering again creates a duplicate. Continue?")) return;
  $("register").disabled = true;
  try {
    const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: account, to: T.to, data: T.data }] });
    localStorage.setItem(LS, hash);
    res.innerHTML = "ارسال شد، در انتظار تأیید · Sent, waiting for confirmation: " + txLink(hash);
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const rc = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (!rc) continue;
      if (rc.status !== "0x1") { res.innerHTML = '<span class="err">تراکنش ناموفق · Transaction failed</span> ' + txLink(hash); $("register").disabled = false; return; }
      const log = (rc.logs || []).find((l) => l.address.toLowerCase() === T.to.toLowerCase() && l.topics[0] === T.topic);
      const id = log ? BigInt(log.topics[1]).toString() : "?";
      res.innerHTML = '<span class="ok">ثبت شد ✓ · Registered ✓</span> Tool ID: <b>' + id + "</b><br>" + txLink(hash) + (id !== "?" ? "<br>" + toolLink(id) : "");
      return;
    }
    res.innerHTML += "<br>هنوز تأیید نشده؛ لینک بالا را در Basescan چک کن · Not confirmed yet, check Basescan.";
  } catch (e) {
    res.innerHTML = '<span class="err">' + (e && e.code === 4001 ? "لغو شد · Rejected in wallet" : esc(e && e.message || e)) + "</span>";
    $("register").disabled = false;
  }
}
$("connect").onclick = async () => {
  if (!eth) { $("status").innerHTML = '<span class="err">کیف‌پول مرورگر پیدا نشد · No browser wallet found (window.ethereum)</span>'; return; }
  try { await eth.request({ method: "eth_requestAccounts" }); } catch (e) { $("status").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; return; }
  await refresh();
};
$("switch").onclick = async () => {
  try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
  catch (e) {
    if (e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902))) {
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_HEX, chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] }] });
    } else $("status").innerHTML = '<span class="err">' + esc(e && e.message || e) + "</span>";
  }
  await refresh();
};
$("register").onclick = register;
const prev = localStorage.getItem(LS);
if (prev) $("res").innerHTML = '<span class="warn">قبلاً از این مرورگر ارسال شده · Already sent from this browser:</span> ' + txLink(prev);
if (eth) { eth.on && eth.on("accountsChanged", refresh); eth.on && eth.on("chainChanged", refresh); refresh(); }
else $("status").innerHTML = "کیف‌پول مرورگر پیدا نشد · No browser wallet detected";
`;

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** sha256 CSP source for the inline script, so the page can run with a strict CSP (no 'unsafe-inline' scripts). */
export const SCRIPT_CSP_HASH = `'sha256-${createHash('sha256').update(SCRIPT).digest('base64')}'`;

export function registerPage(cfg: AppConfig): string {
  const tx = registerTx(cfg);
  const json = JSON.stringify({ ...tx, topic: TOOL_REGISTERED_TOPIC }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="fa">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>BridgePilot · Register on OpenSea Tools (Base)</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;background:#0f1115;color:#e8e8ea;margin:0;padding:24px;line-height:1.6}
 main{max-width:760px;margin:0 auto} h1{font-size:1.4rem;margin:0 0 4px}
 .en{color:#9aa0aa;font-size:.92em;direction:ltr;text-align:left} .fa{direction:rtl;text-align:right}
 .card{background:#181b22;border:1px solid #2a2f3a;border-radius:12px;padding:16px;margin:14px 0}
 button{background:#2f6fed;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:1rem;cursor:pointer;margin:6px 0}
 button:disabled{background:#3a3f4a;color:#8a8f99;cursor:not-allowed}
 code,.mono{font-family:ui-monospace,Menlo,monospace;font-size:.85em;word-break:break-all;direction:ltr}
 .warn{color:#ffb84d} .ok{color:#4ddc8a} .err{color:#ff6b6b} a{color:#7fb2ff} small{color:#9aa0aa}
</style>
</head>
<body><main>
<h1 class="fa">ثبت ابزار BridgePilot در OpenSea روی شبکه‌ی Base</h1>
<div class="en">Register the BridgePilot cross-chain quote tool in the ERC-8257 ToolRegistry on Base mainnet</div>
<div class="card">
 <div class="fa">کیف‌پول خودت را وصل کن. همه‌چیز را خودت امضا می‌کنی؛ این سایت هیچ کلیدی نمی‌بیند. هزینه فقط گس ناچیز Base است (کمتر از یک سنت).</div>
 <div class="en">Connect your own wallet. You sign the transaction yourself; this site never sees a key. Cost: a tiny Base gas fee (under one cent).</div>
 <button id="connect">اتصال کیف‌پول · Connect wallet</button>
 <button id="switch" disabled>رفتن به شبکه‌ی Base · Switch to Base</button>
 <div id="status" class="mono">—</div>
 <div id="acctWarn" class="warn"></div>
</div>
<div class="card">
 <div class="fa"><b>مسیریاب انتقال بین‌زنجیره‌ای</b></div><div class="en"><b>BridgePilot Cross-Chain Route Quote</b></div>
 <div id="dup" class="fa"></div>
 <button id="register" disabled>ثبت · Register tool</button>
 <div id="est" class="en"></div>
 <div id="res" class="mono"></div>
 <details><summary class="en"><small>Transaction details</small></summary><div class="mono">
 to: ${escHtml(tx.to)}<br>function: registerTool(string,bytes32,address)<br>metadataURI: ${escHtml(tx.metadataURI)}<br>manifestHash: ${escHtml(tx.manifestHash)}<br>accessPredicate: ${NO_PREDICATE}<br>creator: ${escHtml(tx.creator)}<br>data: ${escHtml(tx.data)}</div></details>
</div>
<div class="card"><div class="fa"><small>هر ابزار را فقط یک بار ثبت کن؛ ثبت دوباره یک ابزار تکراری می‌سازد.</small></div>
<div class="en"><small>Register only once; registering again creates a duplicate. Registry <a target="_blank" rel="noopener" href="https://basescan.org/address/${REGISTRY}"><code>${REGISTRY}</code></a> · access predicate 0x0 (open; payments via x402)</small></div></div>
</main>
<script type="application/json" id="tx">${json}</script>
<script>${SCRIPT}</script>
</body></html>`;
}

export const REGISTER_PAGE_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src ${SCRIPT_CSP_HASH}; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
