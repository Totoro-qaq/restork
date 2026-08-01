(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))r(s);new MutationObserver(s=>{for(const n of s)if(n.type==="childList")for(const c of n.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&r(c)}).observe(document,{childList:!0,subtree:!0});function a(s){const n={};return s.integrity&&(n.integrity=s.integrity),s.referrerPolicy&&(n.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?n.credentials="include":s.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function r(s){if(s.ep)return;s.ep=!0;const n=a(s);fetch(s.href,n)}})();class I{#t=new Set;#a=0;get cursor(){return this.#a}accept(t){const a=L(t),r=[];for(const s of a){const n=`${s.id}:${s.type}`;this.#t.has(n)||(this.#t.add(n),this.#a=Math.max(this.#a,s.id),r.push(s))}return r}}function L(e){const t=[];for(const a of e.split(/\n\n+/)){if(!a.trim())continue;let r=null,s="message";const n=[];for(const o of a.split(`
`))o.startsWith("id:")?r=Number(o.slice(3).trim()):o.startsWith("event:")?s=o.slice(6).trim():o.startsWith("data:")&&n.push(o.slice(5).trimStart());if(r===null||!Number.isSafeInteger(r)||r<0)throw new Error("Core returned an invalid event cursor");let c;try{c=JSON.parse(n.join(`
`))}catch{throw new Error("Core returned invalid event data")}if(!O(c))throw new Error("Core returned a non-object event");t.push({id:r,type:s,data:c})}return t}function O(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)}class q{#t=null;#a=new Map;async pair(t){const a=await this.#e("POST","/v1/pair",{code:t},!1);this.#t=a.access_token}async loadDashboard(){const[t,a,r,s,n,c]=await Promise.all([this.#e("GET","/v1/runs"),this.#e("GET","/v1/approvals?pending_only=false"),this.#e("GET","/v1/tasks"),this.#e("GET","/v1/radar"),this.#e("GET","/v1/memory").catch(()=>null),this.#e("GET","/v1/daily").catch(()=>null)]);return{runs:t.runs,approvals:a.approvals,taskBoard:r,radar:s,memory:n,daily:c}}async createRun(t,a){const r=crypto.randomUUID(),s=t==="research"?["vault_search","source_read"]:t==="study"?["vault_search","practice"]:["vault_search","handoff_export"];return this.#e("POST","/v1/runs",{schema_version:1,task_id:`dashboard-${r}`,parent_task_id:null,mode:t,goal:a,workspace_scope:"dashboard",constraints:[],completion_criteria:["produce a reviewable verified artifact"],data_policy:{schema_version:1,maximum_outbound_class:"public",allow_private_previews:!1},tool_policy:{schema_version:1,allowed_tools:s,require_approval_for_writes:!0,require_approval_for_external_actions:!0},budgets:{schema_version:1,max_steps:12,max_wall_time_seconds:3600,max_tokens:12e4,max_cost_usd:null,max_retries:2,max_child_tasks:1,reasoning_effort:"high"},created_at:new Date().toISOString()},!0,`dashboard-create-${r}`)}async decideApproval(t,a){return this.#e("POST",`/v1/approvals/${encodeURIComponent(t)}`,{decision:a,decided_by:"local-dashboard"},!0,`dashboard-approval-${crypto.randomUUID()}`)}async radarAction(t,a){return this.#e("POST",`/v1/radar/${encodeURIComponent(t)}/action`,{action:a},!0,`dashboard-radar-${crypto.randomUUID()}`)}async previewTask(t,a){return this.#e("POST",`/v1/tasks/${encodeURIComponent(t)}/preview`,{completed:a},!0,`dashboard-task-preview-${crypto.randomUUID()}`)}async captureTask(t,a){return this.#e("POST","/v1/tasks/quick-capture/preview",{text:t,priority:a||null},!0,`dashboard-task-capture-${crypto.randomUUID()}`)}async applyTask(t){return this.#e("POST",`/v1/tasks/approvals/${encodeURIComponent(t)}/apply`,{},!0,`dashboard-task-apply-${crypto.randomUUID()}`)}async musicCover(){const t=await this.#r("/v1/daily/music/cover",{method:"GET",headers:{Accept:"image/png,image/jpeg,image/webp"}},!0);if(t.status===404)return null;if(!t.ok)throw await y(t);const a=t.headers.get("Content-Type")??"";if(!["image/png","image/jpeg","image/webp"].includes(a))throw new Error("Core returned an unsupported cover type");return t.blob()}async events(t,a){const r=this.#a.get(t)??new I;this.#a.set(t,r);const s=await this.#r(`/v1/runs/${encodeURIComponent(t)}/events`,{method:"GET",headers:{Accept:"text/event-stream","Last-Event-ID":String(Math.max(a,r.cursor))}},!0);if(!s.ok)throw await y(s);return r.accept(await s.text())}async#e(t,a,r,s=!0,n){const c={Accept:"application/json"};r!==void 0&&(c["Content-Type"]="application/json"),n&&(c["Idempotency-Key"]=n);const o=await this.#r(a,{method:t,headers:c,body:r===void 0?void 0:JSON.stringify(r)},s);if(!o.ok)throw await y(o);return await o.json()}#r(t,a,r){const s=new Headers(a.headers);if(r){if(!this.#t)throw new Error("Pair this browser with Restork Core first");s.set("Authorization",`Bearer ${this.#t}`)}return fetch(t,{...a,headers:s,cache:"no-store",credentials:"omit",redirect:"error",referrerPolicy:"no-referrer"})}}async function y(e){let t=`Core returned HTTP ${e.status}`;try{const a=await e.json();typeof a.detail=="string"&&(t=a.detail)}catch{}return new Error(t)}function P(){return`
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
    </section>`}function M(e){const t=e.runs.filter(n=>!Q(n.summary.state)),a=e.approvals.filter(n=>n.decision==="pending"),r=e.taskBoard.tasks.filter(n=>!n.completed),s=e.memory?.records.filter(n=>n.summary)??[];return`
    <div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <section class="dashboard" aria-label="Restork 本地工作台">
      <aside class="sidebar">
        <div class="brand"><strong>RES<span>TORK</span></strong><small>LOCAL-FIRST AGENT</small></div>
        <nav aria-label="主导航">
          ${p("overview","R","仪表盘",!0)}
          ${p("runs","›","运行",!1,t.length)}
          ${p("approvals","✓","审批",!1,a.length)}
          ${p("tasks","□","任务",!1,r.length)}
          ${p("radar","◇","雷达",!1,e.radar.items.length)}
          ${p("memory","M","记忆",!1,s.length)}
        </nav>
        <p class="sidebar-label">新建运行</p>
        ${b("research","R","来源核查和证据卡片")}
        ${b("study","S","学习路径和主动回忆")}
        ${b("work","W","只读规划和交接包")}
        <p class="session">127.0.0.1 · LOCAL<br><b>CORE PAIRED</b></p>
      </aside>
      <main class="workspace">
        <header class="topline">
          <p>&gt; <span id="greeting">今天想研究、学习，还是完成一项工作？</span><span class="caret" aria-hidden="true"></span></p>
          <button class="quiet-button" id="refresh" type="button">REFRESH</button>
        </header>
        <p id="global-status" class="sr-only" role="status"></p>
        <section id="action-panel" class="action-panel" hidden>
          <form id="run-form">
            <input type="hidden" name="mode" id="run-mode" value="research">
            <label for="run-goal">目标 / Goal</label>
            <div><input id="run-goal" name="goal" required maxlength="1000"><button type="submit">START</button></div>
          </form>
          <p id="action-status" class="status" role="status"></p>
        </section>
        <section class="metrics" aria-label="运行概览">
          ${f("research","进行中运行",String(t.length),Y(t))}
          ${f("approval","待审批",String(a.length),"单次能力 · 到期失效")}
          ${f("work","Markdown 任务",String(r.length),e.taskBoard.configured?"Markdown 为准":"尚未配置 Vault")}
          ${f("study","记忆记录",String(s.length),"四层 · 本地可控")}
        </section>
        ${W(e)}
        <section class="view is-visible" data-view-panel="overview">${j(e)}</section>
        <section class="view" data-view-panel="runs" hidden>${N(e.runs)}</section>
        <section class="view" data-view-panel="approvals" hidden>${V(e.approvals)}</section>
        <section class="view" data-view-panel="tasks" hidden>${F(e)}</section>
        <section class="view" data-view-panel="radar" hidden>${B(e)}</section>
        <section class="view" data-view-panel="memory" hidden>${G(e)}</section>
      </main>
    </section>`}function D(e,t){const a=e.summary;return`
    <article class="paper-card detail-card">
      <header><h2>${i(e.task?.goal??a.task_id)}</h2><span class="ribbon ${i(a.mode)}">${i(a.mode)}</span></header>
      <dl class="metadata">
        <div><dt>RUN</dt><dd>${i(a.run_id)}</dd></div>
        <div><dt>STATE</dt><dd>${i(a.state)}</dd></div>
        <div><dt>UPDATED</dt><dd>${m(a.updated_at)}</dd></div>
        <div><dt>TOKENS</dt><dd>${String(e.budget?.usage.tokens??0)}</dd></div>
      </dl>
      <ol class="event-list">${t.length?t.map(J).join(""):"<li>暂无新事件 / No new events.</li>"}</ol>
    </article>`}function U(e){const t=e.metrics;return`<article class="research-result" aria-labelledby="research-result-title">
    <header><div><p class="eyebrow">VALIDATED RESEARCH ARTIFACT</p><h3 id="research-result-title">${i(e.question)}</h3></div><span>${i(e.note_preview.action.toUpperCase())}</span></header>
    <dl class="research-metrics">
      <div><dt>SUPPORTED</dt><dd>${$(t.supported_claim_rate)}</dd></div>
      <div><dt>PRIMARY</dt><dd>${$(t.primary_source_ratio)}</dd></div>
      <div><dt>CITATIONS</dt><dd>${$(t.citation_correctness)}</dd></div>
      <div><dt>RELATED</dt><dd>${t.related_note_count}</dd></div>
    </dl>
    <section><h4>Claims</h4><ol>${e.claims.map(a=>`<li><b>${i(a.kind)}</b>${i(a.statement)}<small>${a.evidence_refs.map(i).join(" · ")||i(a.inference_basis??"explicit inference")}</small></li>`).join("")}</ol></section>
    ${e.conflicts.length?`<section><h4>Conflicts</h4><ul>${e.conflicts.map(a=>`<li>${i(a.description)}</li>`).join("")}</ul></section>`:""}
    <section><h4>Markdown preview · ${i(e.note_preview.relative_path)}</h4><pre>${i(e.note_preview.markdown)}</pre></section>
    <p class="fine">Preview only · Core has not written this note. Artifact ${i(e.artifact_id)}</p>
  </article>`}function d(e){return e instanceof Error?e.message:"Unexpected local error"}function j(e){const t=e.runs[0],a=e.approvals.find(s=>s.decision==="pending"),r=e.taskBoard.tasks.filter(s=>!s.completed).slice(0,3);return`<div class="board">
    ${t?H(t):v("运行","还没有运行。选择 Research、Study 或 Work 开始。")}
    ${a?E(a):v("审批","没有待审批动作。")}
    <article class="paper-card"><header><h2>Markdown 任务</h2><span class="ribbon work">CORE AUTHORITY</span></header>
      ${r.length?r.map(s=>`<p class="task-row"><b>${i(s.fields.priority??"P–")}</b>${i(R(s.text))}<small>${i(s.relative_path)} · L${s.line_number}</small></p>`).join(""):`<p class="empty">${e.taskBoard.configured?"没有未完成任务。":"配置 Vault 后显示 Markdown 任务。"}</p>`}
    </article>
    <article class="paper-card radar-summary"><header><h2>今日雷达</h2><span class="ribbon radar">VIA CORE</span></header>
      ${e.radar.items.slice(0,4).map(X).join("")||`<p class="empty">${e.radar.configured?"暂时没有 Radar 项。":"Radar 尚未配置来源。"}</p>`}
    </article>
  </div>`}function N(e){return`<article class="paper-card full-card"><header><h2>运行 / Runs</h2><span class="ribbon research">CORE STATE</span></header>
    <div class="split-view"><div class="item-list">${e.map(t=>`<button type="button" class="list-item" data-run-id="${i(t.summary.run_id)}"><b>${i(t.summary.mode.toUpperCase())}</b><span>${i(t.task?.goal??t.summary.task_id)}</span><small>${i(t.summary.state)} · ${m(t.summary.updated_at)}</small></button>`).join("")||'<p class="empty">没有运行。</p>'}</div><div id="run-detail" class="detail-placeholder">选择一个运行查看事件。</div></div>
  </article>`}function V(e){return`<div class="stack">${e.map(E).join("")||v("审批","没有审批记录。")}</div>`}function F(e){return e.taskBoard.configured?`<article class="paper-card full-card"><header><h2>Markdown 任务</h2><span class="ribbon work">MARKDOWN TRUTH</span></header>
    <form id="quick-task-form" class="quick-task-form"><label for="quick-task">快速捕获 / Quick capture</label><div><input id="quick-task" name="text" required maxlength="500" placeholder="一行 Markdown 任务"><select name="priority" aria-label="优先级"><option value="">P–</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select><button type="submit">PREVIEW</button></div></form>
    <div class="task-list">${e.taskBoard.tasks.map(t=>`<label class="task-row ${t.completed?"is-complete":""}"><input type="checkbox" data-task-id="${i(t.task_id)}" ${t.completed?"checked":""}><span>${i(R(t.text))}<small>${i(t.relative_path)} · L${t.line_number} · ${i(t.fields.due??"no due date")}</small></span></label>`).join("")||'<p class="empty">没有任务。</p>'}</div>
    <p class="fine">勾选与捕获只生成精确 diff；Markdown 仅在审批后由 Core 原子写入。</p>
  </article>`:v("Markdown 任务","使用 --vault-dir 配置私有 Vault。浏览器不会持有 Vault 路径之外的权限。")}function B(e){const t=[["my_stars","My Stars"],["trending","Trending"],["hn","HN"],["papers","Papers"]];return`<article class="paper-card full-card"><header><h2>Radar</h2><span class="ribbon radar">CORE CONNECTORS</span></header>
    <div id="research-result" class="research-result-host" role="status"></div>
    ${e.radar.configured?`<div class="lanes">${t.map(([a,r])=>`<section><h3>${r}</h3>${e.radar.items.filter(s=>s.lane===a).map(K).join("")||'<p class="empty">Empty</p>'}</section>`).join("")}</div>`:'<p class="empty">Radar 来源尚未配置；浏览器不会自行联网。</p>'}
  </article>`}function G(e){if(!e.memory)return v("四层记忆","Memory service 尚未配置。");const t=e.memory.records.filter(a=>a.summary);return`<article class="paper-card full-card"><header><h2>四层记忆 / Memory</h2><span class="ribbon study">LOCAL</span></header>
    <div class="memory-layers">${e.memory.architecture.map(a=>`<section><b>${i(a.toUpperCase())}</b><strong>${e.memory?.counts[a]??0}</strong></section>`).join("")}</div>
    <div class="memory-list">${t.map(z).join("")||'<p class="empty">尚未保存用户批准的记忆。</p>'}</div>
    <p class="fine">TTL/LRU 只清理临时和可重建数据，不会清理 Markdown、Profile、审批或审计记录。</p>
  </article>`}function H(e){const t=e.budget?.usage,a=e.budget?.budget,r=t&&a?.max_tokens?Math.min(100,t.tokens/a.max_tokens*100):0;return`<article class="paper-card run-card"><header><h2>最近运行</h2><span class="ribbon ${i(e.summary.mode)}">${i(e.summary.mode)}</span></header>
    <p class="run-title">${i(e.task?.goal??e.summary.task_id)}</p>
    <progress class="progress-native" aria-label="Token budget ${r.toFixed(0)}%" max="100" value="${r.toFixed(1)}">${r.toFixed(0)}%</progress>
    <p class="fine">${i(e.summary.state)} · ${t?.tokens??0} tokens · ${m(e.summary.updated_at)}</p>
  </article>`}function E(e){const t=e.decision==="pending",a=e.decision==="approved"&&e.action_kind==="task_write";return`<article class="paper-card approval-card"><header><h2>审批请求</h2><span class="ribbon approval">${i(e.decision)}</span></header>
    <p class="run-title">${i(e.human_summary)}</p>
    <dl class="metadata compact"><div><dt>TARGET</dt><dd>${i(e.canonical_scope)}</dd></div><div><dt>POLICY</dt><dd>${i(e.policy_version)}</dd></div><div><dt>DIGEST</dt><dd>${i(e.action_digest.slice(0,16))}…</dd></div><div><dt>EXPIRES</dt><dd>${m(e.expires_at)}</dd></div></dl>
    ${t?`<div class="stamps"><button class="stamp approve" type="button" data-approval-id="${i(e.approval_id)}" data-action-kind="${i(e.action_kind)}" data-decision="approve">APPROVE</button><button class="stamp reject" type="button" data-approval-id="${i(e.approval_id)}" data-action-kind="${i(e.action_kind)}" data-decision="reject">REJECT</button></div>`:""}
    ${a?`<div class="stamps"><button class="stamp approve" type="button" data-task-apply="${i(e.approval_id)}">APPLY TASK</button></div>`:""}
  </article>`}function W(e){const t=e.daily,a=t?.weather,r=t?.calendar,s=t?.music,n=s?.recommendation;return`<section class="daily-context" aria-label="每日上下文">
    <article class="daily-card clock-card">
      <header><h2>本地时间</h2><span>LOCAL</span></header>
      <svg class="roman-clock" viewBox="0 0 100 100" role="img" aria-labelledby="clock-title clock-description">
        <title id="clock-title">Roman numeral local clock</title><desc id="clock-description">An analog clock marked I through XII.</desc>
        <circle cx="50" cy="50" r="45"></circle><circle class="clock-rule" cx="50" cy="50" r="39"></circle>
        <g class="clock-numerals"><text x="50" y="14">XII</text><text x="70" y="19">I</text><text x="84" y="33">II</text><text x="89" y="53">III</text><text x="84" y="73">IV</text><text x="70" y="87">V</text><text x="50" y="92">VI</text><text x="30" y="87">VII</text><text x="16" y="73">VIII</text><text x="11" y="53">IX</text><text x="16" y="33">X</text><text x="30" y="19">XI</text></g>
        <line data-clock-hour class="clock-hand hour-hand" x1="50" y1="53" x2="50" y2="29"></line><line data-clock-minute class="clock-hand minute-hand" x1="50" y1="54" x2="50" y2="19"></line><line data-clock-second class="clock-hand second-hand" x1="50" y1="57" x2="50" y2="16"></line><circle class="clock-pin" cx="50" cy="50" r="2.5"></circle>
      </svg><time id="clock-text">读取本地时间…</time>
    </article>
    <article class="daily-card weather-card"><header><h2>天气</h2><span>${i(a?.status??"offline")}</span></header>
      ${a?.configured&&a.temperature_c!==null?`<strong class="weather-temperature">${a.temperature_c.toFixed(1)}°</strong><p>${i(a.condition)} · 体感 ${a.apparent_temperature_c?.toFixed(1)??"–"}°</p><small>${i(a.location_label)} · 湿度 ${a.relative_humidity_percent??"–"}%</small><em>${i(a.attribution)}</em>`:`<p class="daily-empty">${i(a?.message??"在私有 Profile 中配置天气；当前没有网络请求。")}</p>`}
    </article>
    <article class="daily-card calendar-card"><header><h2>日历</h2><span>${i(r?.status??"offline")}</span></header>
      <ol>${r?.events.slice(0,3).map(c=>`<li><time>${m(c.starts_at)}</time><b>${i(c.title)}</b>${c.redacted?"<small>PRIVATE · REDACTED</small>":""}</li>`).join("")||`<li class="daily-empty">${i(r?.message??"选择本地只读 ICS 文件。")}</li>`}</ol>
    </article>
    <article class="daily-card music-card"><header><h2>每日一曲</h2><span>${i(s?.status??"offline")}</span></header>
      ${n?`<div class="music-layout"><div class="disc" data-music-disc><div class="disc-label"><span>RESTORK</span><img id="music-cover" alt="${i(`${n.title} cover`)}" hidden></div></div><div class="music-copy"><strong>${i(n.title)}</strong><p>${i([n.artist,n.album].filter(Boolean).join(" · ")||"Private playlist")}</p><small>${i(n.analysis)}</small><button type="button" data-music-toggle aria-pressed="false">ROTATE CD</button></div></div>`:`<p class="daily-empty">${i(s?.message??"导入私有 JSON/CSV 歌单后生成每日推荐。")}</p>`}
    </article>
  </section>`}function K(e){return`<article class="radar-item"><a href="${i(e.url)}" target="_blank" rel="noreferrer">${i(e.title)}</a><small>${i(e.source)} · ${i(e.state)}</small><div><button type="button" data-radar-id="${i(e.item_id)}" data-radar-action="research">research</button><button type="button" data-radar-id="${i(e.item_id)}" data-radar-action="read_later">稍后</button><button type="button" data-radar-id="${i(e.item_id)}" data-radar-action="make_task">建任务</button><button type="button" data-radar-id="${i(e.item_id)}" data-radar-action="dismiss">忽略</button></div></article>`}function X(e){return`<p class="radar-row"><strong>${i(e.title)}</strong><small>${i(e.source)} · ${i(e.lane)}</small></p>`}function z(e){return`<article><b>${i(e.layer)} · ${i(e.kind)}</b><p>${i(e.summary)}</p><small>${i(e.retention_class)} · ${i(e.provenance)} · ${m(e.updated_at)}</small></article>`}function J(e){return`<li><b>${i(e.type)}</b><span>#${e.id}</span><code>${i(JSON.stringify(e.data))}</code></li>`}function p(e,t,a,r,s){return`<button class="nav-item ${r?"is-active":""}" type="button" data-view="${e}"><b class="icon">${t}</b>${a}${s?`<em>${s}</em>`:""}</button>`}function b(e,t,a){return`<button class="mode" type="button" data-mode="${e}"><b class="icon ${e}">${t}</b><span><strong>${e}</strong><small>${a}</small></span></button>`}function f(e,t,a,r){return`<article class="metric ${e}"><small>${t}</small><strong>${a}</strong><span>${i(r)}</span></article>`}function v(e,t){return`<article class="paper-card"><header><h2>${i(e)}</h2></header><p class="empty">${i(t)}</p></article>`}function Y(e){const t=new Map;for(const a of e)t.set(a.summary.mode,(t.get(a.summary.mode)??0)+1);return[...t].map(([a,r])=>`${a} ×${r}`).join(" · ")||"等待新任务"}function R(e){return e.replace(/\s+#todo\b/,"").replace(/\s+\[[a-z]+:: [^\]]+\]/g,"").replace(/\s+\^restork-[a-z0-9]+$/,"").trim()}function Q(e){return["completed","failed","cancelled"].includes(e)}function m(e){const t=new Date(e);return Number.isNaN(t.getTime())?"unknown":new Intl.DateTimeFormat("zh-CN",{dateStyle:"medium",timeStyle:"short"}).format(t)}function $(e){return`${Math.round(Math.max(0,Math.min(1,e))*100)}%`}function i(e){return e.replace(/[&<>'"]/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[t]??t)}const S=new WeakMap;function Z(e){S.get(e)?.();const t=e.querySelector("[data-clock-hour]"),a=e.querySelector("[data-clock-minute]"),r=e.querySelector("[data-clock-second]"),s=e.querySelector("#clock-text");if(!t||!a||!r||!s)return;const n=window.matchMedia?.("(prefers-reduced-motion: reduce)").matches??!1,c=()=>{const h=new Date,_=h.getSeconds(),x=h.getMinutes()+_/60,A=h.getHours()%12+x/60;t.setAttribute("transform",`rotate(${A*30} 50 50)`),a.setAttribute("transform",`rotate(${x*6} 50 50)`),r.setAttribute("transform",`rotate(${_*6} 50 50)`),s.dateTime=h.toISOString(),s.textContent=new Intl.DateTimeFormat("zh-CN",{dateStyle:"full",timeStyle:"medium"}).format(h)};c();const o=window.setInterval(c,n?6e4:1e3);S.set(e,()=>window.clearInterval(o))}const g=new WeakMap;function ee(e,t={}){const a=t.api??new q;if(t.snapshot){k(e,a,t.snapshot);return}e.innerHTML=P();const r=e.querySelector("#pair-form");r?.addEventListener("submit",s=>{s.preventDefault(),te(e,a,new FormData(r))})}async function te(e,t,a){const r=e.querySelector("#pair-status"),s=String(a.get("code")??"").trim();if(s){r&&(r.textContent="正在与本地 Core 配对…");try{await t.pair(s),k(e,t,await t.loadDashboard())}catch(n){r&&(r.textContent=d(n))}}}function k(e,t,a){w(e),e.innerHTML=M(a),Z(e),e.querySelectorAll("[data-view]").forEach(r=>{r.addEventListener("click",()=>C(e,r.dataset.view??"overview"))}),e.querySelectorAll("[data-mode]").forEach(r=>{r.addEventListener("click",()=>ae(e,r.dataset.mode))}),e.querySelector("#run-form")?.addEventListener("submit",r=>{r.preventDefault(),re(e,t,r.currentTarget)}),e.querySelector("#refresh")?.addEventListener("click",()=>{l(e,t)}),e.querySelectorAll("[data-approval-id]").forEach(r=>{r.addEventListener("click",()=>{se(e,t,r)})}),e.querySelectorAll("[data-task-apply]").forEach(r=>{r.addEventListener("click",()=>{oe(e,t,r)})}),e.querySelectorAll("[data-task-id]").forEach(r=>{r.addEventListener("change",()=>{ne(e,t,r)})}),e.querySelector("#quick-task-form")?.addEventListener("submit",r=>{r.preventDefault(),ce(e,t,r.currentTarget)}),e.querySelectorAll("[data-radar-id]").forEach(r=>{r.addEventListener("click",()=>{ie(e,t,r)})}),e.querySelectorAll("[data-run-id]").forEach(r=>{r.addEventListener("click",()=>{de(e,t,a,r)})}),le(e),a.daily?.music.recommendation?.cover_available&&ue(e,t)}function C(e,t){e.querySelectorAll("[data-view-panel]").forEach(a=>{a.hidden=a.dataset.viewPanel!==t,a.classList.toggle("is-visible",!a.hidden)}),e.querySelectorAll("[data-view]").forEach(a=>{a.classList.toggle("is-active",a.dataset.view===t)})}function ae(e,t){const a=e.querySelector("#action-panel"),r=e.querySelector("#run-mode");a&&(a.hidden=!1),r&&(r.value=t),e.querySelector("#run-goal")?.focus()}async function re(e,t,a){const r=new FormData(a),s=String(r.get("mode")),n=String(r.get("goal")??"").trim(),c=e.querySelector("#action-status");if(n){c&&(c.textContent="正在创建本地运行…");try{const o=await t.createRun(s,n);c&&(c.textContent=`已创建 ${o.run_id}`),await l(e,t,"runs")}catch(o){c&&(c.textContent=d(o))}}}async function se(e,t,a){a.disabled=!0;try{const r=a.dataset.decision==="approve"?"approve":"reject",s=await t.decideApproval(a.dataset.approvalId??"",r);r==="approve"&&s.action_kind==="task_write"?(await t.applyTask(s.approval_id),await l(e,t,"tasks")):await l(e,t,"approvals")}catch(r){a.disabled=!1,u(e,d(r))}}async function ie(e,t,a){a.disabled=!0;try{const r=a.dataset.radarAction,s=await t.radarAction(a.dataset.radarId??"",r);if(await l(e,t,r==="make_task"?"approvals":"radar"),s.research_artifact){const n=e.querySelector("#research-result");n&&(n.innerHTML=U(s.research_artifact))}}catch(r){a.disabled=!1,u(e,d(r))}}async function ne(e,t,a){a.disabled=!0;try{await t.previewTask(a.dataset.taskId??"",a.checked),u(e,"已生成 Markdown diff，等待审批。 / Preview ready for approval."),await l(e,t,"approvals")}catch(r){a.checked=!a.checked,a.disabled=!1,u(e,d(r))}}async function ce(e,t,a){const r=new FormData(a),s=String(r.get("text")??"").trim(),n=String(r.get("priority")??"");if(!s)return;const c=a.querySelector('button[type="submit"]');c&&(c.disabled=!0);try{await t.captureTask(s,n),await l(e,t,"approvals")}catch(o){c&&(c.disabled=!1),u(e,d(o))}}async function oe(e,t,a){a.disabled=!0;try{await t.applyTask(a.dataset.taskApply??""),await l(e,t,"tasks")}catch(r){a.disabled=!1,u(e,d(r))}}async function de(e,t,a,r){const s=e.querySelector("#run-detail"),n=a.runs.find(c=>c.summary.run_id===r.dataset.runId);if(!(!s||!n)){s.textContent="读取本地事件…";try{s.innerHTML=D(n,await t.events(n.summary.run_id,0))}catch(c){s.textContent=d(c)}}}async function l(e,t,a="overview"){try{k(e,t,await t.loadDashboard()),C(e,a)}catch(r){u(e,d(r))}}function u(e,t){const a=e.querySelector("#global-status")??e.querySelector("#action-status");a&&(a.textContent=t)}function le(e){const t=e.querySelector("[data-music-toggle]"),a=e.querySelector("[data-music-disc]");!t||!a||t.addEventListener("click",()=>{const r=a.classList.toggle("is-playing");t.setAttribute("aria-pressed",String(r)),t.textContent=r?"PAUSE CD":"ROTATE CD"})}async function ue(e,t){try{const a=await t.musicCover(),r=e.querySelector("#music-cover");if(!a||!r||typeof URL.createObjectURL!="function")return;w(e);const s=URL.createObjectURL(a);g.set(e,s),r.addEventListener("error",()=>{r.hidden=!0,w(e)},{once:!0}),r.src=s,r.hidden=!1}catch(a){u(e,d(a))}}function w(e){const t=g.get(e);t&&URL.revokeObjectURL(t),g.delete(e)}const T=document.querySelector("#app");T&&ee(T);
