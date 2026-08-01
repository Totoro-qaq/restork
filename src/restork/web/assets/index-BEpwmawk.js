(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))r(s);new MutationObserver(s=>{for(const i of s)if(i.type==="childList")for(const o of i.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&r(o)}).observe(document,{childList:!0,subtree:!0});function t(s){const i={};return s.integrity&&(i.integrity=s.integrity),s.referrerPolicy&&(i.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?i.credentials="include":s.crossOrigin==="anonymous"?i.credentials="omit":i.credentials="same-origin",i}function r(s){if(s.ep)return;s.ep=!0;const i=t(s);fetch(s.href,i)}})();class k{#a=new Set;#t=0;get cursor(){return this.#t}accept(a){const t=S(a),r=[];for(const s of t){const i=`${s.id}:${s.type}`;this.#a.has(i)||(this.#a.add(i),this.#t=Math.max(this.#t,s.id),r.push(s))}return r}}function S(e){const a=[];for(const t of e.split(/\n\n+/)){if(!t.trim())continue;let r=null,s="message";const i=[];for(const d of t.split(`
`))d.startsWith("id:")?r=Number(d.slice(3).trim()):d.startsWith("event:")?s=d.slice(6).trim():d.startsWith("data:")&&i.push(d.slice(5).trimStart());if(r===null||!Number.isSafeInteger(r)||r<0)throw new Error("Core returned an invalid event cursor");let o;try{o=JSON.parse(i.join(`
`))}catch{throw new Error("Core returned invalid event data")}if(!E(o))throw new Error("Core returned a non-object event");a.push({id:r,type:s,data:o})}return a}function E(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)}class R{#a=null;#t=new Map;async pair(a){const t=await this.#e("POST","/v1/pair",{code:a},!1);this.#a=t.access_token}async loadDashboard(){const[a,t,r,s,i]=await Promise.all([this.#e("GET","/v1/runs"),this.#e("GET","/v1/approvals?pending_only=true"),this.#e("GET","/v1/tasks"),this.#e("GET","/v1/radar"),this.#e("GET","/v1/memory").catch(()=>null)]);return{runs:a.runs,approvals:t.approvals,taskBoard:r,radar:s,memory:i}}async createRun(a,t){const r=crypto.randomUUID(),s=a==="research"?"vault_search":a==="study"?"practice":"handoff_export";return this.#e("POST","/v1/runs",{schema_version:1,task_id:`dashboard-${r}`,parent_task_id:null,mode:a,goal:t,workspace_scope:"dashboard",constraints:[],completion_criteria:["produce a reviewable verified artifact"],data_policy:{schema_version:1,maximum_outbound_class:"public",allow_private_previews:!1},tool_policy:{schema_version:1,allowed_tools:[s],require_approval_for_writes:!0,require_approval_for_external_actions:!0},budgets:{schema_version:1,max_steps:12,max_wall_time_seconds:3600,max_tokens:12e4,max_cost_usd:null,max_retries:2,max_child_tasks:1,reasoning_effort:"high"},created_at:new Date().toISOString()},!0,`dashboard-create-${r}`)}async decideApproval(a,t){return this.#e("POST",`/v1/approvals/${encodeURIComponent(a)}`,{decision:t,decided_by:"local-dashboard"},!0,`dashboard-approval-${crypto.randomUUID()}`)}async radarAction(a,t){await this.#e("POST",`/v1/radar/${encodeURIComponent(a)}/action`,{action:t},!0,`dashboard-radar-${crypto.randomUUID()}`)}async events(a,t){const r=this.#t.get(a)??new k;this.#t.set(a,r);const s=await this.#r(`/v1/runs/${encodeURIComponent(a)}/events`,{method:"GET",headers:{Accept:"text/event-stream","Last-Event-ID":String(Math.max(t,r.cursor))}},!0);if(!s.ok)throw await b(s);return r.accept(await s.text())}async#e(a,t,r,s=!0,i){const o={Accept:"application/json"};r!==void 0&&(o["Content-Type"]="application/json"),i&&(o["Idempotency-Key"]=i);const d=await this.#r(t,{method:a,headers:o,body:r===void 0?void 0:JSON.stringify(r)},s);if(!d.ok)throw await b(d);return await d.json()}#r(a,t,r){const s=new Headers(t.headers);if(r){if(!this.#a)throw new Error("Pair this browser with Restork Core first");s.set("Authorization",`Bearer ${this.#a}`)}return fetch(a,{...t,headers:s,cache:"no-store",credentials:"omit",redirect:"error",referrerPolicy:"no-referrer"})}}async function b(e){let a=`Core returned HTTP ${e.status}`;try{const t=await e.json();typeof t.detail=="string"&&(a=t.detail)}catch{}return new Error(a)}function T(){return`
    <div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <section class="pairing" aria-labelledby="pairing-title">
      <p class="eyebrow">Restork · LOCAL-FIRST AGENT · LOOPBACK ONLY</p>
      <h1 id="pairing-title">RES<span>TORK</span></h1>
      <p class="pairing-copy">一个 Core，连接 <b>Research</b>、<b>Study</b> 与 <b>Work</b>。<br>
      One governed Core for research, study, and work.</p>
      <form id="pair-form" class="pair-form">
        <label for="pair-code">输入终端显示的一次性 Web 配对码</label>
        <div><input id="pair-code" name="code" required autocomplete="off" spellcheck="false"><button type="submit">PAIR</button></div>
      </form>
      <p id="pair-status" class="status" role="status">Token 仅保存在当前页面内存中。</p>
    </section>`}function C(e){const a=e.runs.filter(i=>!B(i.summary.state)),t=e.approvals.filter(i=>i.decision==="pending"),r=e.taskBoard.tasks.filter(i=>!i.completed),s=e.memory?.records.filter(i=>i.summary)??[];return`
    <div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <section class="dashboard" aria-label="Restork 本地工作台">
      <aside class="sidebar">
        <div class="brand"><strong>RES<span>TORK</span></strong><small>LOCAL-FIRST AGENT</small></div>
        <nav aria-label="主导航">
          ${c("overview","R","仪表盘",!0)}
          ${c("runs","›","运行",!1,a.length)}
          ${c("approvals","✓","审批",!1,t.length)}
          ${c("tasks","□","任务",!1,r.length)}
          ${c("radar","◇","雷达",!1,e.radar.items.length)}
          ${c("memory","M","记忆",!1,s.length)}
        </nav>
        <p class="sidebar-label">新建运行</p>
        ${v("research","R","来源核查和证据卡片")}
        ${v("study","S","学习路径和主动回忆")}
        ${v("work","W","只读规划和交接包")}
        <p class="session">127.0.0.1 · LOCAL<br><b>CORE PAIRED</b></p>
      </aside>
      <main class="workspace">
        <header class="topline">
          <p>&gt; <span id="greeting">今天想研究、学习，还是完成一项工作？</span><span class="caret" aria-hidden="true"></span></p>
          <button class="quiet-button" id="refresh" type="button">REFRESH</button>
        </header>
        <section id="action-panel" class="action-panel" hidden>
          <form id="run-form">
            <input type="hidden" name="mode" id="run-mode" value="research">
            <label for="run-goal">目标 / Goal</label>
            <div><input id="run-goal" name="goal" required maxlength="1000"><button type="submit">START</button></div>
          </form>
          <p id="action-status" class="status" role="status"></p>
        </section>
        <section class="metrics" aria-label="运行概览">
          ${m("research","进行中运行",String(a.length),V(a))}
          ${m("approval","待审批",String(t.length),"单次能力 · 到期失效")}
          ${m("work","Markdown 任务",String(r.length),e.taskBoard.configured?"Markdown 为准":"尚未配置 Vault")}
          ${m("study","记忆记录",String(s.length),"四层 · 本地可控")}
        </section>
        <section class="view is-visible" data-view-panel="overview">${O(e)}</section>
        <section class="view" data-view-panel="runs" hidden>${L(e.runs)}</section>
        <section class="view" data-view-panel="approvals" hidden>${x(e.approvals)}</section>
        <section class="view" data-view-panel="tasks" hidden>${q(e)}</section>
        <section class="view" data-view-panel="radar" hidden>${M(e)}</section>
        <section class="view" data-view-panel="memory" hidden>${P(e)}</section>
      </main>
    </section>`}function A(e,a){const t=e.summary;return`
    <article class="paper-card detail-card">
      <header><h2>${n(e.task?.goal??t.task_id)}</h2><span class="ribbon ${n(t.mode)}">${n(t.mode)}</span></header>
      <dl class="metadata">
        <div><dt>RUN</dt><dd>${n(t.run_id)}</dd></div>
        <div><dt>STATE</dt><dd>${n(t.state)}</dd></div>
        <div><dt>UPDATED</dt><dd>${p(t.updated_at)}</dd></div>
        <div><dt>TOKENS</dt><dd>${String(e.budget?.usage.tokens??0)}</dd></div>
      </dl>
      <ol class="event-list">${a.length?a.map(U).join(""):"<li>暂无新事件 / No new events.</li>"}</ol>
    </article>`}function l(e){return e instanceof Error?e.message:"Unexpected local error"}function O(e){const a=e.runs[0],t=e.approvals.find(s=>s.decision==="pending"),r=e.taskBoard.tasks.filter(s=>!s.completed).slice(0,3);return`<div class="board">
    ${a?I(a):u("运行","还没有运行。选择 Research、Study 或 Work 开始。")}
    ${t?g(t):u("审批","没有待审批动作。")}
    <article class="paper-card"><header><h2>Markdown 任务</h2><span class="ribbon work">CORE AUTHORITY</span></header>
      ${r.length?r.map(s=>`<p class="task-row"><b>${n(s.fields.priority??"P–")}</b>${n(w(s.text))}<small>${n(s.relative_path)} · L${s.line_number}</small></p>`).join(""):`<p class="empty">${e.taskBoard.configured?"没有未完成任务。":"配置 Vault 后显示 Markdown 任务。"}</p>`}
    </article>
    <article class="paper-card radar-summary"><header><h2>今日雷达</h2><span class="ribbon radar">VIA CORE</span></header>
      ${e.radar.items.slice(0,4).map(j).join("")||`<p class="empty">${e.radar.configured?"暂时没有 Radar 项。":"Radar 尚未配置来源。"}</p>`}
    </article>
  </div>`}function L(e){return`<article class="paper-card full-card"><header><h2>运行 / Runs</h2><span class="ribbon research">CORE STATE</span></header>
    <div class="split-view"><div class="item-list">${e.map(a=>`<button type="button" class="list-item" data-run-id="${n(a.summary.run_id)}"><b>${n(a.summary.mode.toUpperCase())}</b><span>${n(a.task?.goal??a.summary.task_id)}</span><small>${n(a.summary.state)} · ${p(a.summary.updated_at)}</small></button>`).join("")||'<p class="empty">没有运行。</p>'}</div><div id="run-detail" class="detail-placeholder">选择一个运行查看事件。</div></div>
  </article>`}function x(e){return`<div class="stack">${e.map(g).join("")||u("审批","没有审批记录。")}</div>`}function q(e){return e.taskBoard.configured?`<article class="paper-card full-card"><header><h2>Markdown 任务</h2><span class="ribbon work">MARKDOWN TRUTH</span></header>
    <div class="task-list">${e.taskBoard.tasks.map(a=>`<label class="task-row ${a.completed?"is-complete":""}"><input type="checkbox" ${a.completed?"checked":""} disabled><span>${n(w(a.text))}<small>${n(a.relative_path)} · L${a.line_number} · ${n(a.fields.due??"no due date")}</small></span></label>`).join("")||'<p class="empty">没有任务。</p>'}</div>
    <p class="fine">任务状态来自 Core 重新扫描的 Markdown；写入预览与审批将在单文件事务中执行。</p>
  </article>`:u("Markdown 任务","使用 --vault-dir 配置私有 Vault。浏览器不会持有 Vault 路径之外的权限。")}function M(e){const a=[["my_stars","My Stars"],["trending","Trending"],["hn","HN"],["papers","Papers"]];return`<article class="paper-card full-card"><header><h2>Radar</h2><span class="ribbon radar">CORE CONNECTORS</span></header>
    ${e.radar.configured?`<div class="lanes">${a.map(([t,r])=>`<section><h3>${r}</h3>${e.radar.items.filter(s=>s.lane===t).map(N).join("")||'<p class="empty">Empty</p>'}</section>`).join("")}</div>`:'<p class="empty">Radar 来源尚未配置；浏览器不会自行联网。</p>'}
  </article>`}function P(e){if(!e.memory)return u("四层记忆","Memory service 尚未配置。");const a=e.memory.records.filter(t=>t.summary);return`<article class="paper-card full-card"><header><h2>四层记忆 / Memory</h2><span class="ribbon study">LOCAL</span></header>
    <div class="memory-layers">${e.memory.architecture.map(t=>`<section><b>${n(t.toUpperCase())}</b><strong>${e.memory?.counts[t]??0}</strong></section>`).join("")}</div>
    <div class="memory-list">${a.map(D).join("")||'<p class="empty">尚未保存用户批准的记忆。</p>'}</div>
    <p class="fine">TTL/LRU 只清理临时和可重建数据，不会清理 Markdown、Profile、审批或审计记录。</p>
  </article>`}function I(e){const a=e.budget?.usage,t=e.budget?.budget,r=a&&t?.max_tokens?Math.min(100,a.tokens/t.max_tokens*100):0;return`<article class="paper-card run-card"><header><h2>最近运行</h2><span class="ribbon ${n(e.summary.mode)}">${n(e.summary.mode)}</span></header>
    <p class="run-title">${n(e.task?.goal??e.summary.task_id)}</p>
    <progress class="progress-native" aria-label="Token budget ${r.toFixed(0)}%" max="100" value="${r.toFixed(1)}">${r.toFixed(0)}%</progress>
    <p class="fine">${n(e.summary.state)} · ${a?.tokens??0} tokens · ${p(e.summary.updated_at)}</p>
  </article>`}function g(e){const a=e.decision==="pending";return`<article class="paper-card approval-card"><header><h2>审批请求</h2><span class="ribbon approval">${n(e.decision)}</span></header>
    <p class="run-title">${n(e.human_summary)}</p>
    <dl class="metadata compact"><div><dt>TARGET</dt><dd>${n(e.canonical_scope)}</dd></div><div><dt>POLICY</dt><dd>${n(e.policy_version)}</dd></div><div><dt>DIGEST</dt><dd>${n(e.action_digest.slice(0,16))}…</dd></div><div><dt>EXPIRES</dt><dd>${p(e.expires_at)}</dd></div></dl>
    ${a?`<div class="stamps"><button class="stamp approve" type="button" data-approval-id="${n(e.approval_id)}" data-decision="approve">APPROVE</button><button class="stamp reject" type="button" data-approval-id="${n(e.approval_id)}" data-decision="reject">REJECT</button></div>`:""}
  </article>`}function N(e){return`<article class="radar-item"><a href="${n(e.url)}" target="_blank" rel="noreferrer">${n(e.title)}</a><small>${n(e.source)} · ${n(e.state)}</small><div><button type="button" data-radar-id="${n(e.item_id)}" data-radar-action="research">research</button><button type="button" data-radar-id="${n(e.item_id)}" data-radar-action="read_later">稍后</button><button type="button" data-radar-id="${n(e.item_id)}" data-radar-action="make_task">建任务</button><button type="button" data-radar-id="${n(e.item_id)}" data-radar-action="dismiss">忽略</button></div></article>`}function j(e){return`<p class="radar-row"><strong>${n(e.title)}</strong><small>${n(e.source)} · ${n(e.lane)}</small></p>`}function D(e){return`<article><b>${n(e.layer)} · ${n(e.kind)}</b><p>${n(e.summary)}</p><small>${n(e.retention_class)} · ${n(e.provenance)} · ${p(e.updated_at)}</small></article>`}function U(e){return`<li><b>${n(e.type)}</b><span>#${e.id}</span><code>${n(JSON.stringify(e.data))}</code></li>`}function c(e,a,t,r,s){return`<button class="nav-item ${r?"is-active":""}" type="button" data-view="${e}"><b class="icon">${a}</b>${t}${s?`<em>${s}</em>`:""}</button>`}function v(e,a,t){return`<button class="mode" type="button" data-mode="${e}"><b class="icon ${e}">${a}</b><span><strong>${e}</strong><small>${t}</small></span></button>`}function m(e,a,t,r){return`<article class="metric ${e}"><small>${a}</small><strong>${t}</strong><span>${n(r)}</span></article>`}function u(e,a){return`<article class="paper-card"><header><h2>${n(e)}</h2></header><p class="empty">${n(a)}</p></article>`}function V(e){const a=new Map;for(const t of e)a.set(t.summary.mode,(a.get(t.summary.mode)??0)+1);return[...a].map(([t,r])=>`${t} ×${r}`).join(" · ")||"等待新任务"}function w(e){return e.replace(/\s+#todo\b/,"").replace(/\s+\[[a-z]+:: [^\]]+\]/g,"").replace(/\s+\^restork-[a-z0-9]+$/,"").trim()}function B(e){return["completed","failed","cancelled"].includes(e)}function p(e){const a=new Date(e);return Number.isNaN(a.getTime())?"unknown":new Intl.DateTimeFormat("zh-CN",{dateStyle:"medium",timeStyle:"short"}).format(a)}function n(e){return e.replace(/[&<>'"]/g,a=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[a]??a)}function F(e,a={}){const t=a.api??new R;if(a.snapshot){h(e,t,a.snapshot);return}e.innerHTML=T();const r=e.querySelector("#pair-form");r?.addEventListener("submit",s=>{s.preventDefault(),G(e,t,new FormData(r))})}async function G(e,a,t){const r=e.querySelector("#pair-status"),s=String(t.get("code")??"").trim();if(s){r&&(r.textContent="正在与本地 Core 配对…");try{await a.pair(s),h(e,a,await a.loadDashboard())}catch(i){r&&(r.textContent=l(i))}}}function h(e,a,t){e.innerHTML=C(t),e.querySelectorAll("[data-view]").forEach(r=>{r.addEventListener("click",()=>_(e,r.dataset.view??"overview"))}),e.querySelectorAll("[data-mode]").forEach(r=>{r.addEventListener("click",()=>H(e,r.dataset.mode))}),e.querySelector("#run-form")?.addEventListener("submit",r=>{r.preventDefault(),W(e,a,r.currentTarget)}),e.querySelector("#refresh")?.addEventListener("click",()=>{f(e,a)}),e.querySelectorAll("[data-approval-id]").forEach(r=>{r.addEventListener("click",()=>{K(e,a,r)})}),e.querySelectorAll("[data-radar-id]").forEach(r=>{r.addEventListener("click",()=>{z(e,a,r)})}),e.querySelectorAll("[data-run-id]").forEach(r=>{r.addEventListener("click",()=>{J(e,a,t,r)})})}function _(e,a){e.querySelectorAll("[data-view-panel]").forEach(t=>{t.hidden=t.dataset.viewPanel!==a,t.classList.toggle("is-visible",!t.hidden)}),e.querySelectorAll("[data-view]").forEach(t=>{t.classList.toggle("is-active",t.dataset.view===a)})}function H(e,a){const t=e.querySelector("#action-panel"),r=e.querySelector("#run-mode");t&&(t.hidden=!1),r&&(r.value=a),e.querySelector("#run-goal")?.focus()}async function W(e,a,t){const r=new FormData(t),s=String(r.get("mode")),i=String(r.get("goal")??"").trim(),o=e.querySelector("#action-status");if(i){o&&(o.textContent="正在创建本地运行…");try{const d=await a.createRun(s,i);o&&(o.textContent=`已创建 ${d.run_id}`),await f(e,a,"runs")}catch(d){o&&(o.textContent=l(d))}}}async function K(e,a,t){t.disabled=!0;try{await a.decideApproval(t.dataset.approvalId??"",t.dataset.decision==="approve"?"approve":"reject"),await f(e,a,"approvals")}catch(r){t.disabled=!1,y(e,l(r))}}async function z(e,a,t){t.disabled=!0;try{await a.radarAction(t.dataset.radarId??"",t.dataset.radarAction),await f(e,a,"radar")}catch(r){t.disabled=!1,y(e,l(r))}}async function J(e,a,t,r){const s=e.querySelector("#run-detail"),i=t.runs.find(o=>o.summary.run_id===r.dataset.runId);if(!(!s||!i)){s.textContent="读取本地事件…";try{s.innerHTML=A(i,await a.events(i.summary.run_id,0))}catch(o){s.textContent=l(o)}}}async function f(e,a,t="overview"){try{h(e,a,await a.loadDashboard()),_(e,t)}catch(r){y(e,l(r))}}function y(e,a){const t=e.querySelector("#action-status");t&&(t.textContent=a)}const $=document.querySelector("#app");$&&F($);
