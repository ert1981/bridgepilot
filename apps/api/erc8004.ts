/**
 * ERC-8004 (Trustless Agents) identity for BridgePilot.
 *
 * - `registration(cfg)`: the agent registration file served at /.well-known/agent-registration.json (and
 *   /agent-registration.json). Its URL is the agentURI passed to `register(string)`.
 * - `register8004Page(cfg)`: static page where the owner registers the agent in the Identity Registry on
 *   Base with their OWN injected wallet: Base chain check, exact calldata shown, expected-owner check and
 *   duplicate warnings (balanceOf, earlier Registered events of this wallet, same agentURI, localStorage).
 *   Same CSP-hash script model as /register-onchain; the server never sees a key.
 *
 * Identity Registry on Base mainnet (github.com/erc-8004/erc-8004-contracts):
 * 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432, register(string agentURI) returns (uint256 agentId),
 * event Registered(uint256 indexed agentId, string agentURI, address indexed owner).
 */
import { createHash } from 'node:crypto';
import { encodeFunctionData } from 'viem';
import type { AppConfig } from '../../src/config/env.js';
import { MANIFEST_PATH, ICON_PATH, TOOL_PATH } from './opensea-tool.js';

export const NAME = 'BridgePilot';
export const CHAIN_ID = 8453;
export const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const OWNER = '0x93714D5970f511Ac22f0E5635D3fBF538f717cd4';
export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
export const WELL_KNOWN_PATH = '/.well-known/agent-registration.json';
export const ENV_AGENT_ID = 'ERC8004_AGENT_ID';
export const MCP_PROTOCOL = '2025-06-18';

const REGISTER_ABI = [{
  type: 'function', name: 'register', stateMutability: 'nonpayable',
  inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ name: 'agentId', type: 'uint256' }],
}] as const;

export function encodeRegister(agentUri: string): `0x${string}` {
  return encodeFunctionData({ abi: REGISTER_ABI, functionName: 'register', args: [agentUri] });
}

export function agentUri(cfg: AppConfig): string {
  return `${cfg.publicBaseUrl}${WELL_KNOWN_PATH}`;
}

export function registration(cfg: AppConfig) {
  const base = cfg.publicBaseUrl;
  return {
    type: REGISTRATION_TYPE,
    name: NAME,
    description:
      'Cross-chain route optimizer for AI agents: compares LI.FI and Across quotes across Ethereum, Base, Arbitrum, Optimism and Polygon, ' +
      'computes net received value in USD, filters unsafe routes and returns the best route with alternatives. Non-custodial. Pay per call with x402 (USDC on Base).',
    image: `${base}${ICON_PATH}`,
    services: [
      { name: 'web', endpoint: `${base}/` },
      { name: 'MCP', endpoint: `${base}/mcp`, version: MCP_PROTOCOL },
      { name: 'x402', endpoint: `${base}${TOOL_PATH}` },
      { name: 'OpenAPI', endpoint: `${base}/openapi.json` },
      { name: 'ERC-8257', endpoint: `${base}${MANIFEST_PATH}` },
    ],
    x402Support: true,
    active: true,
    registrations: cfg.erc8004AgentId ? [{ agentId: Number(cfg.erc8004AgentId), agentRegistry: `eip155:${CHAIN_ID}:${IDENTITY_REGISTRY}` }] : [],
    supportedTrust: ['reputation'],
  };
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SCRIPT = String.raw`"use strict";
const CHAIN_HEX = "0x2105";
const C = JSON.parse(document.getElementById("cfg").textContent);
const REGISTRY = C.registry;
const OWNER = C.owner;
const AGENT_URI = C.agentUri;
const CALLDATA = C.calldata;
const TOPIC = "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a";
const DEPLOY_BLOCK = "0x27bbd27";
const KNOWN_ID = C.agentId;
const LS = "erc8004-reg-" + AGENT_URI;
let account = null, chainOk = false, dupBlock = false, dupFound = false;
const $ = (id) => document.getElementById(id);
const eth = window.ethereum;
function setStatus(html){ $("status").innerHTML = html; }
function fmtEth(wei){ return (Number(wei) / 1e18).toFixed(9); }
function txLink(h){ return '<a target="_blank" rel="noopener" href="https://basescan.org/tx/' + h + '">' + h + '</a>'; }
function nftLink(id){ return '<a target="_blank" rel="noopener" href="https://basescan.org/nft/' + REGISTRY + '/' + id + '">#' + id + '</a>'; }
function esc(s){ return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function decodeUri(data){
  try { const h = data.slice(2); const len = parseInt(h.slice(64, 128), 16); const hex = h.slice(128, 128 + len * 2);
    const bytes = new Uint8Array(hex.match(/../g).map(b => parseInt(b, 16))); return new TextDecoder().decode(bytes);
  } catch (e) { return "?"; }
}

async function checkDuplicates(){
  const out = [];
  dupBlock = false; dupFound = false;
  if (KNOWN_ID) { out.push("این سرویس قبلاً با agentId " + nftLink(KNOWN_ID) + " ثبت شده · Already registered as agent " + nftLink(KNOWN_ID) + " (server config). Registering again creates a duplicate."); dupBlock = true; }
  const prev = localStorage.getItem(LS);
  if (prev) { out.push("قبلاً از این مرورگر ارسال شده · Already sent from this browser: " + txLink(prev)); dupFound = true; }
  try {
    const data = "0x70a08231" + account.slice(2).toLowerCase().padStart(64, "0");
    const bal = BigInt(await eth.request({ method: "eth_call", params: [{ to: REGISTRY, data }, "latest"] }));
    if (bal > 0n) { out.push("این کیف‌پول همین حالا " + bal + " عامل ERC-8004 دارد · This wallet already owns " + bal + " ERC-8004 agent(s)."); dupFound = true; }
  } catch (e) { out.push("بررسی موجودی ممکن نشد · balanceOf check failed: " + (e && e.message ? e.message : e)); }
  try {
    const logs = await eth.request({ method: "eth_getLogs", params: [{ address: REGISTRY, fromBlock: DEPLOY_BLOCK, toBlock: "latest",
      topics: [TOPIC, null, "0x" + account.slice(2).toLowerCase().padStart(64, "0")] }] });
    for (const l of logs || []) {
      const uri = decodeUri(l.data), id = BigInt(l.topics[1]).toString();
      const same = uri === AGENT_URI;
      out.push((same ? '<span class="err">همین آدرس قبلاً ثبت شده · Same agentURI already registered</span> ' : "") + "agent " + nftLink(id) + " → " + esc(uri));
      if (same) dupBlock = true; else dupFound = true;
    }
    if (!logs || !logs.length) out.push('<span class="ok">ثبت قبلی از این کیف‌پول پیدا نشد · No earlier registration by this wallet found.</span>');
  } catch (e) { out.push("جست‌وجوی رویدادهای قبلی ممکن نشد (RPC کیف‌پول محدودیت دارد) · Could not scan earlier Registered events: " + (e && e.message ? e.message : e)); }
  $("dup").innerHTML = out.join("<br>");
}

async function refresh(){
  if (!eth) return;
  const accts = await eth.request({ method: "eth_accounts" });
  account = accts[0] || null;
  const chainId = await eth.request({ method: "eth_chainId" });
  chainOk = String(chainId).toLowerCase() === CHAIN_HEX;
  $("switch").disabled = !account || chainOk;
  let s = account ? "حساب · Account: " + account : "وصل نیست · Not connected";
  s += "<br>شبکه · Network: " + (chainOk ? '<span class="ok">Base ✓</span>' : '<span class="warn">' + chainId + ' (not Base)</span>');
  if (account && chainOk) {
    try { const bal = await eth.request({ method: "eth_getBalance", params: [account, "latest"] });
      s += "<br>موجودی · Balance: " + fmtEth(BigInt(bal)) + " ETH";
      if (BigInt(bal) === 0n) s += ' <span class="err">— برای گس کمی ETH روی Base لازم است · you need a little ETH on Base for gas</span>';
    } catch (e) {}
  }
  setStatus(s);
  const mismatch = account && account.toLowerCase() !== OWNER.toLowerCase();
  $("acctWarn").innerHTML = mismatch ? "هشدار: این حساب با مالک مورد انتظار یکی نیست؛ حساب " + OWNER + " را انتخاب کن.<br><span class='en'>Warning: connected account differs from the expected owner " + OWNER + ". The agent NFT would belong to this other account.</span>" : "";
  $("register").disabled = true;
  if (account && chainOk) {
    await checkDuplicates();
    $("register").disabled = mismatch || dupBlock;
    if (!mismatch && !dupBlock) estimate();
  }
}

async function estimate(){
  try {
    const [gas, price] = await Promise.all([
      eth.request({ method: "eth_estimateGas", params: [{ from: account, to: REGISTRY, data: CALLDATA }] }),
      eth.request({ method: "eth_gasPrice" })]);
    const wei = BigInt(gas) * BigInt(price);
    $("est").innerHTML = "<small>Estimated gas: " + BigInt(gas) + " × " + (Number(BigInt(price)) / 1e9).toFixed(4) + " gwei ≈ " + fmtEth(wei) + " ETH (plus a tiny L1 data fee)</small>";
  } catch (e) { $("est").innerHTML = '<small class="err">Simulation failed: ' + (e && e.message ? e.message : e) + "</small>"; }
}

$("register").onclick = async () => {
  const btn = $("register"), res = $("res");
  if (dupFound && !confirm("ثبت قبلی پیدا شد. دوباره ثبت شود (عامل تکراری)؟\nAn earlier registration was found. Register again (duplicate agent)?")) return;
  btn.disabled = true;
  try {
    const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: account, to: REGISTRY, data: CALLDATA, value: "0x0" }] });
    localStorage.setItem(LS, hash);
    res.innerHTML = "ارسال شد، در انتظار تأیید · Sent, waiting for confirmation: " + txLink(hash);
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const rc = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (!rc) continue;
      if (rc.status !== "0x1") { res.innerHTML = '<span class="err">تراکنش ناموفق · Transaction failed</span> ' + txLink(hash); btn.disabled = false; return; }
      const log = (rc.logs || []).find(l => l.address.toLowerCase() === REGISTRY.toLowerCase() && l.topics[0] === TOPIC);
      const id = log ? BigInt(log.topics[1]).toString() : "?";
      localStorage.setItem(LS + "-id", id);
      res.innerHTML = '<span class="ok">ثبت شد ✓ · Registered ✓</span> agentId: <b id="agentId">' + id + "</b> " + (id !== "?" ? nftLink(id) : "") + "<br>" + txLink(hash) +
        "<br>Render env: <code>" + C.env + "=" + id + "</code>";
      return;
    }
    res.innerHTML += "<br>هنوز تأیید نشده؛ Basescan را چک کن · Not confirmed yet, check Basescan.";
  } catch (e) {
    res.innerHTML = '<span class="err">' + (e && e.code === 4001 ? "لغو شد · Rejected in wallet" : (e && e.message ? e.message : e)) + "</span>";
    btn.disabled = false;
  }
};
$("connect").onclick = async () => {
  if (!eth) { setStatus('<span class="err">کیف‌پول مرورگر پیدا نشد · No browser wallet found (window.ethereum).</span>'); return; }
  try { await eth.request({ method: "eth_requestAccounts" }); } catch (e) { setStatus('<span class="err">' + e.message + "</span>"); return; }
  await refresh();
};
$("switch").onclick = async () => {
  try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
  catch (e) {
    if (e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902))) {
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_HEX, chainName: "Base",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] }] });
    } else { setStatus('<span class="err">' + (e && e.message ? e.message : e) + "</span>"); }
  }
  await refresh();
};
if (eth) { eth.on && eth.on("accountsChanged", refresh); eth.on && eth.on("chainChanged", refresh); refresh(); }
else setStatus("کیف‌پول مرورگر پیدا نشد · No browser wallet detected");
`;

export const SCRIPT_8004_CSP_HASH = `'sha256-${createHash('sha256').update(SCRIPT).digest('base64')}'`;
export const REGISTER_8004_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src ${SCRIPT_8004_CSP_HASH}; connect-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export function register8004Page(cfg: AppConfig): string {
  const uri = agentUri(cfg);
  const calldata = encodeRegister(uri);
  const json = JSON.stringify({ registry: IDENTITY_REGISTRY, owner: OWNER, agentUri: uri, calldata, agentId: cfg.erc8004AgentId ?? '', env: ENV_AGENT_ID })
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="fa">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${NAME} · Register in the ERC-8004 Identity Registry (Base)</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;background:#0f1115;color:#e8e8ea;margin:0;padding:24px;line-height:1.6}
 main{max-width:760px;margin:0 auto}
 h1{font-size:1.4rem;margin:0 0 4px} .en{color:#9aa0aa;font-size:.92em;direction:ltr;text-align:left}
 .fa{direction:rtl;text-align:right}
 .card{background:#181b22;border:1px solid #2a2f3a;border-radius:12px;padding:16px;margin:14px 0}
 button{background:#2f6fed;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:1rem;cursor:pointer;margin:6px 0}
 button:disabled{background:#3a3f4a;color:#8a8f99;cursor:not-allowed}
 code,.mono{font-family:ui-monospace,Menlo,monospace;font-size:.85em;word-break:break-all;direction:ltr}
 .warn{color:#ffb84d} .ok{color:#4ddc8a} .err{color:#ff6b6b}
 a{color:#7fb2ff} small{color:#9aa0aa}
</style>
</head>
<body><main>
<h1 class="fa">ثبت ${NAME} در رجیستری هویت ERC-8004 روی Base</h1>
<div class="en">Register ${NAME} as an agent in the ERC-8004 Identity Registry on Base mainnet</div>

<div class="card">
 <div class="fa">کیف‌پول خودت را وصل کن و خودت امضا کن؛ این سایت هیچ کلیدی نمی‌بیند. یک تراکنش، گس حدود ۱۳۵ هزار (کمتر از یک سنت روی Base). این کار یک NFT هویت (AGENT) به کیف‌پولت می‌دهد. فقط یک بار ثبت کن.</div>
 <div class="en">Connect your own wallet; you sign yourself and this site never sees a key. One transaction (~135k gas, under one cent on Base). It mints an agent identity NFT (AGENT) to your wallet. Register only once.</div>
 <button id="connect">اتصال کیف‌پول · Connect wallet</button>
 <button id="switch" disabled>رفتن به شبکه‌ی Base · Switch to Base</button>
 <div id="status" class="mono">—</div>
 <div id="acctWarn" class="warn"></div>
</div>

<div class="card">
 <div class="fa"><b>تراکنش دقیق</b></div><div class="en"><b>Exact transaction</b></div>
 <div class="mono">chain: Base (8453)<br>to: <a target="_blank" rel="noopener" href="https://basescan.org/address/${IDENTITY_REGISTRY}">${IDENTITY_REGISTRY}</a> (IdentityRegistry, proxy)<br>
 function: register(string agentURI) · selector 0xf2c298be<br>
 agentURI: <a target="_blank" rel="noopener" href="${escHtml(uri)}">${escHtml(uri)}</a><br>value: 0<br>data: <span id="calldata">${calldata}</span></div>
 <div id="dup" class="warn"></div>
 <button id="register" disabled>ثبت · Register agent</button>
 <div id="est" class="en"><small></small></div>
 <div id="res" class="mono"></div>
</div>

<div class="card">
 <div class="fa"><small>بعد از تأیید، شماره‌ی عامل (agentId) این‌جا نشان داده می‌شود. آن را در Render به متغیر <code>${ENV_AGENT_ID}</code> بده تا فایل ثبت، بخش registrations را نشان دهد.</small></div>
 <div class="en"><small>After confirmation the agentId appears here. Set it on Render as <code>${ENV_AGENT_ID}</code> so the registration file lists it under <code>registrations</code>.</small></div>
</div>
</main>
<script type="application/json" id="cfg">${json}</script>
<script>${SCRIPT}</script>
</body></html>
`;
}
