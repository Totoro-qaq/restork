(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))l(s);new MutationObserver(s=>{for(const a of s)if(a.type==="childList")for(const r of a.addedNodes)r.tagName==="LINK"&&r.rel==="modulepreload"&&l(r)}).observe(document,{childList:!0,subtree:!0});function n(s){const a={};return s.integrity&&(a.integrity=s.integrity),s.referrerPolicy&&(a.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?a.credentials="include":s.crossOrigin==="anonymous"?a.credentials="omit":a.credentials="same-origin",a}function l(s){if(s.ep)return;s.ep=!0;const a=n(s);fetch(s.href,a)}})();const c="今天想研究、学习，还是完成一项工作？";function i(){return`
    <div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <section class="dashboard" aria-label="Restork 本地工作台">
      <aside class="sidebar">
        <div class="brand"><strong>RES<span>TORK</span></strong><small>LOCAL-FIRST AGENT</small></div>
        <nav aria-label="主导航">
          <button class="nav-item is-active" type="button" data-view="仪表盘"><b class="icon research">R</b>仪表盘</button>
          <button class="nav-item" type="button" data-view="运行"><b class="icon radar">›</b>运行 <em>3</em></button>
          <button class="nav-item" type="button" data-view="审批"><b class="icon approval">✓</b>审批 <em>2</em></button>
          <button class="nav-item" type="button" data-view="任务"><b class="icon work">□</b>任务</button>
          <button class="nav-item" type="button" data-view="雷达"><b class="icon study">◇</b>雷达</button>
        </nav>
        <p class="sidebar-label">三种模式</p>
        <button class="mode is-selected" type="button"><b class="icon research">R</b><span><strong>Research</strong><small>来源核查和证据卡片</small></span><i aria-label="运行中"></i></button>
        <button class="mode" type="button"><b class="icon study">S</b><span><strong>Study</strong><small>学习路径和主动回忆</small></span></button>
        <button class="mode" type="button"><b class="icon work">W</b><span><strong>Work</strong><small>只读规划和交接包</small></span></button>
        <p class="session">LOOPBACK ONLY<br>本地 Core 已配对</p>
      </aside>
      <main class="workspace">
        <header class="topline"><p>&gt; <span id="greeting">${c}</span><span class="caret" aria-hidden="true"></span></p><span>127.0.0.1 · LOCAL</span></header>
        <section class="metrics" aria-label="运行概览">
          <article class="metric research"><small>进行中运行</small><strong>3</strong><span>Research ×2 · Work ×1</span></article>
          <article class="metric approval"><small>待审批</small><strong>2</strong><span>最早 14 分钟后过期</span></article>
          <article class="metric work"><small>今日 Tokens</small><strong>48.2k</strong><span>预算 120k · 38%</span></article>
          <article class="metric study"><small>本地笔记</small><strong>1,024</strong><span>Markdown 为准</span></article>
        </section>
        <section class="board">
          <article class="paper-card run-card">
            <header><h1>进行中的运行</h1><span class="ribbon research">RESEARCH</span></header>
            <p class="run-title"><a href="#run">R-01K7X</a> DeepSeek 技术报告的来源核查和证据整理</p>
            <div class="progress" aria-label="运行进度 64%"><i></i></div><div class="progress-meta"><span>STEP 7/11 · SYNTHESIZE</span><span>64%</span></div>
            <ol class="steps"><li class="done">扫描本地相关笔记，命中 4 篇</li><li class="done">抓取公开来源，去重后 5 篇</li><li class="current">生成证据卡片，主来源占比 80%</li><li>输出未解问题和建议实验</li></ol>
            <div class="chips"><span class="chip cyan">arXiv</span><span class="chip amber">GitHub</span><span class="chip">官方博客</span><span class="chip">[[DeepSeek 笔记]]</span></div>
            <div class="budget"><span>BUDGET</span><div><i></i></div><span>46k / 120k</span></div>
          </article>
          <article class="paper-card approval-card">
            <header><h1>审批请求</h1><span class="ribbon approval">单次有效</span></header>
            <p class="run-title">向 <strong>[[DeepSeek 笔记]]</strong> 追加 3 条引用</p><p class="fine">写入预览 · 单文件事务 · 可回滚</p>
            <pre class="diff" aria-label="写入预览"><span>&gt; 现有结论保持不变</span><b>+ [^1] 官方技术报告</b><b>+ [^2] GitHub: deepseek-ai</b><b>+ [^3] 定价页快照</b></pre>
            <div class="stamps"><button class="stamp approve" type="button">APPROVE</button><button class="stamp reject" type="button">REJECT</button></div>
            <p class="approval-note" id="approval-status">13:42 后过期 · nonce 已校验 · 不保存到浏览器</p>
          </article>
          <article class="paper-card tasks-card">
            <header><h1>Markdown 任务</h1><span class="ribbon work">CORE 权威</span></header>
            <label class="task"><input type="checkbox"><span><b>P1</b>实现本地 Dashboard 的审批视图<small>due 2026-08-15 · [[Restork]]</small></span></label>
            <label class="task"><input type="checkbox"><span><b class="high">P0</b>复核出站网关的 SSRF 用例<small>source restork:run/01k</small></span></label>
            <label class="task complete"><input type="checkbox" checked><span><b class="low">P2</b>整理模型对比笔记的引用格式<small>completed 2026-07-30</small></span><em>DONE</em></label>
          </article>
          <article class="paper-card radar-card">
            <header><h1>今日雷达</h1><span class="ribbon radar">VIA GATEWAY</span></header>
            <div class="lanes">
              <section><h2>My Stars <b>3</b></h2><p><strong>deepseek-ai 发布权重说明</strong><small>你 star 的仓库 · 2h</small><button type="button">research</button><button type="button">稍后</button></p><p><strong>Obsidian 插件 API 更新</strong><small>你 star 的仓库 · 6h</small><button type="button">research</button></p></section>
              <section><h2>Trending <b>5</b></h2><p><strong>本地优先 agent 运行时的新讨论</strong><small>GitHub Trending · Python</small><button type="button">research</button><button type="button">建任务</button></p><p><strong>一个 SQLite 事件溯源的极简库</strong><small>GitHub Trending · 12h</small><button type="button">稍后</button></p></section>
              <section><h2>HN <b>4</b></h2><p><strong>Show HN: 浏览器中的打字机模拟器</strong><small>Hacker News · 312</small><button type="button">research</button></p><p><strong>为什么我们回到了本地软件</strong><small>Hacker News · 587</small><button type="button">建任务</button></p></section>
            </div>
          </article>
        </section>
      </main>
    </section>`}function p(e){e.querySelectorAll(".nav-item").forEach(t=>{t.addEventListener("click",()=>{e.querySelectorAll(".nav-item").forEach(n=>n.classList.remove("is-active")),t.classList.add("is-active")})}),e.querySelectorAll(".stamp").forEach(t=>{t.addEventListener("click",()=>{const n=e.querySelector("#approval-status");n&&(n.textContent=t.classList.contains("approve")?"已在本地预览中批准，等待 Core 消费。":"已在本地预览中拒绝，未写入任何笔记。")})})}function b(e){e.innerHTML=i(),p(e)}const o=document.querySelector("#app");o&&b(o);
