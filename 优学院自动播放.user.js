// ==UserScript==
// @name         ULearning Auto-Play
// @name:zh-CN   优学院课程自动播放
// @namespace    https://github.com/youxueyuan-autoplay
// @version      3.0.0
// @description  Auto-play ULearning (ulearning.cn) courses: auto-play videos, click "Next" when done, click "Next Chapter" at chapter end, stop when finished. Playback speed is left to the Global Speed extension.
// @description:zh-CN  优学院(ulearning.cn)课程自动播放：自动播放视频、播完自动点"下一页"、章节结束自动点"继续下一章"、全部跑完自动停止。倍速交给 Global Speed 插件。
// @author       youxueyuan-autoplay
// @match        *://www.ulearning.cn/*
// @match        *://*.ulearning.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     *  ⚙️ 配置区 —— 如果优学院改版导致定位不准，只需改这里
     * ============================================================ */

    const CONFIG = {
        // —— 已确认的优学院(ulearning.cn)真实 class ——
        // 目录栏容器
        catalogColSelector: '.catalog-col',
        // 返回课程章节按钮（也可作为"页面已就绪"标志）
        backBtnSelector: '.back-btn',
        // 收起/展开目录按钮
        hideCatalogSelector: '.hide-catalog-btn',
        // 课程标题
        courseTitleSelector: '.course-title',

        // —— 视频中央的"播放"按钮（半透明白色圆形 + 白色三角）——
        playButtonSelectors: [
            '.vjs-big-play-button',
            '.play-btn', '.playBtn', '.big-play',
            '[class*="play-btn"]', '[class*="playBtn"]',
            '[class*="big-play"]', '[class*="playButton"]',
            '[class*="play-icon"]', '[class*="icon-play"]',
            '.player-mask', '[class*="player-mask"]',
            '.video-mask', '[class*="video-mask"]',
            'video ~ [class*="play"]', '[class*="startPlay"]'
        ],

        // —— 视频元素 ——
        videoSelectors: ['video', 'iframe[src*="player"]', 'iframe[src*="video"]'],

        // —— "下一页"按钮：底部导航栏右侧「下一页 ›」——
        nextSelectors: [
            '[class*="next"]',
            '[class*="Next"]',
            'a[href*="next"]',
            'button[class*="next"]'
        ],
        // "下一页"按钮包含的关键文本（用于过滤，避免误点其他含 next 的元素）
        nextKeywords: ['下一页', '下一节', '下一个', '下一页 ›', '下一页›'],

        // —— "继续下一章"按钮：完成弹窗里的「继续下一章 >>」——
        nextChapterSelectors: [
            '[class*="nextChapter"]', '[class*="next-chapter"]',
            '[class*="nextChap"]', '[class*="goNext"]',
            'button', 'a', 'div', 'span'
        ],
        // "继续下一章"按钮包含的关键文本
        nextChapterKeywords: ['继续下一章', '下一章', '开始下一章'],

        // —— 目录栏里"已完成"的对勾：橙红实心圆 + 白色对勾 ——
        // 完成态 class / 属性关键词
        doneKeywords: ['finish', 'complete', 'done', 'studied', 'learned',
            'check', 'success', 'passed', 'watched', 'finished', 'isFinish',
            'finishFlag', 'hasFinish', 'compelete', 'finish-flag',
            'learned-flag', 'status-finish', 'status-complete', 'done-icon',
            'check-icon', 'finished-icon', 'is-done', 'has-done', 'isFinish'],

        // 视频已看完的绿色标记文字
        watchedMarkText: ['已看完', '已观看', '已完成', '看完', '完成'],

        // 视频总时长兜底判断：已播放时长与总时长之差小于该值(秒)即视为播完
        endThresholdSec: 2,

        // 等待对勾/标记出现的超时（毫秒）
        waitForDoneTimeout: 20000,

        // 等待视频加载的超时（毫秒）
        waitForVideoTimeout: 15000,

        // 两次操作之间的最小间隔（毫秒），用于限速
        actionInterval: 1500,

        // 找不到目标时的最大重试次数
        maxRetry: 5,

        // 连续 N 轮无进展则停止（防止死循环）
        maxNoProgress: 15,

        // 是否输出详细日志
        debug: true,

        // 是否显示悬浮控制面板
        showPanel: true,

        // 是否自动开始（false 则需手动点面板"开始"）
        autoStart: false,
    };

    /* ============================================================
     *  工具函数
     * ============================================================ */

    const log = (...args) => CONFIG.debug && console.log('[优学院自动播放]', ...args);
    const warn = (...args) => console.warn('[优学院自动播放]', ...args);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 等待某条件成立（轮询），返回第一个真值，超时返回 null
    async function waitFor(fn, timeout = 8000, interval = 300) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const v = fn();
                if (v) return v;
            } catch (e) { /* ignore */ }
            await sleep(interval);
        }
        return null;
    }

    // 跨 iframe 查找单个元素
    function queryDoc(selector) {
        try {
            const el = document.querySelector(selector);
            if (el) return el;
        } catch (e) { }
        for (const f of document.querySelectorAll('iframe')) {
            try {
                const doc = f.contentDocument;
                if (doc) {
                    const el = doc.querySelector(selector);
                    if (el) return el;
                }
            } catch (e) { }
        }
        return null;
    }

    // 跨 iframe 查找所有元素
    function queryAllDoc(selector) {
        const arr = [];
        try { document.querySelectorAll(selector).forEach(e => arr.push(e)); } catch (e) { }
        for (const f of document.querySelectorAll('iframe')) {
            try {
                const doc = f.contentDocument;
                if (doc) doc.querySelectorAll(selector).forEach(e => arr.push(e));
            } catch (e) { }
        }
        return arr;
    }

    // 尝试一组选择器，返回第一个命中的元素
    function firstMatch(selectors, all = false) {
        for (const sel of selectors) {
            try {
                const els = all ? queryAllDoc(sel) : [queryDoc(sel)];
                for (const el of els) if (el) return el;
            } catch (e) { }
        }
        return null;
    }

    // 在所有元素中，按"文本包含关键字"查找最合适的元素（返回最小的叶子元素）
    function findByKeywords(keywords, rootSelectors, root = null) {
        const candidates = [];
        const collect = (node) => {
            const text = (node.textContent || '').trim();
            if (!text) return;
            for (const kw of keywords) {
                if (text.includes(kw)) {
                    candidates.push(node);
                    break;
                }
            }
        };
        if (root) {
            collect(root);
        } else {
            // 遍历文档 + iframe
            document.querySelectorAll('*').forEach(collect);
            for (const f of document.querySelectorAll('iframe')) {
                try {
                    const doc = f.contentDocument;
                    if (doc) doc.querySelectorAll('*').forEach(collect);
                } catch (e) { }
            }
        }
        if (!candidates.length) return null;
        // 取文本最短（最内层/最具体）的元素
        candidates.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
        return candidates[0];
    }

    // 判断元素是否可见
    function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        try {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        } catch (e) { }
        return true;
    }

    // 触发点击
    function clickEl(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { }
        try {
            el.click();
            return true;
        } catch (e) {
            try {
                const opts = { bubbles: true, cancelable: true, view: window };
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.dispatchEvent(new MouseEvent('click', opts));
                return true;
            } catch (e2) { return false; }
        }
    }

    /* ============================================================
     *  视频定位与播放
     * ============================================================ */

    function getVideo() {
        const v = firstMatch(CONFIG.videoSelectors);
        if (!v) return null;
        if (v.tagName === 'IFRAME') {
            try {
                const inner = v.contentDocument && v.contentDocument.querySelector('video');
                if (inner) return inner;
            } catch (e) { }
            return null;
        }
        return v.tagName === 'VIDEO' ? v : null;
    }

    // 定位中央"播放"按钮（视频暂停、需要点击才开始时用）
    function getPlayButton() {
        // 1. 先按选择器找
        const btn = firstMatch(CONFIG.playButtonSelectors);
        if (btn && isVisible(btn)) return btn;
        // 2. 兜底：找视频上覆盖的"三角"图标（用 ::before 或背景三角难判断，此处依赖选择器）
        return null;
    }

    // 确保视频在播放；若被暂停则尝试点播放按钮 / 调用 play()
    async function ensurePlaying(video) {
        if (!video) return false;
        try {
            if (video.paused || video.ended) {
                video.play().catch(() => { });
            }
            // 若仍暂停，尝试点击中央播放按钮
            await sleep(500);
            if (video.paused) {
                const btn = getPlayButton();
                if (btn) { clickEl(btn); log('▶️ 已点击中央播放按钮'); }
                else video.play().catch(() => { });
            }
            return true;
        } catch (e) { return false; }
    }

    /* ============================================================
     *  任务完成检测
     * ============================================================ */

    // 获取目录栏容器
    function getCatalog() {
        return document.querySelector('.catalog-list') || document.querySelector('.catalog-col') || document;
    }

    // 获取所有 page（最小编排单元，对应每个视频/ppt/文档）
    function getAllPages() {
        const catalog = getCatalog();
        return Array.from(catalog.querySelectorAll('.page-name'));
    }

    // 判断单个 page 是否已完成（.page-name 上有 complete class）
    function isPageDone(pageNameEl) {
        if (!pageNameEl) return false;
        // 精确：complete class
        if (pageNameEl.classList.contains('complete')) return true;
        // 兜底：内部有 <i class="iconfont finish">
        const fin = pageNameEl.querySelector('i.finish, i[class*="finish"]');
        if (fin) return true;
        return false;
    }

    // 获取当前正在学习的 page（.page-name 上有 active class）
    function getCurrentPageName() {
        const catalog = getCatalog();
        const act = catalog.querySelector('.page-name.active');
        if (act) return act;
        // 兜底：标题栏文字匹配
        const titleEl = document.querySelector(CONFIG.courseTitleSelector);
        if (titleEl) {
            const t = (titleEl.textContent || '').trim();
            if (t) {
                const pages = getAllPages();
                for (const p of pages) {
                    if ((p.textContent || '').includes(t)) return p;
                }
            }
        }
        return null;
    }

    // 判断"当前小节"是否已完成
    function isCurrentDone() {
        const cur = getCurrentPageName();
        if (cur && isPageDone(cur)) {
            return true;
        }
        // 兜底：视频区有绿色"已看完"标记
        for (const kw of CONFIG.watchedMarkText) {
            const el = findByKeywords([kw], [], null);
            if (el && isVisible(el)) {
                const txt = (el.textContent || '').trim();
                if (txt.includes(kw) && (/[✓✔√]/.test(txt) || isGreen(el))) {
                    return true;
                }
            }
        }
        return false;
    }

    // 判断元素文字/图标是否为绿色（"已看完"标记是绿色）
    function isGreen(el) {
        if (!el) return false;
        const all = [el, ...Array.from(el.querySelectorAll('*'))];
        for (const n of all) {
            try {
                const cs = getComputedStyle(n);
                const c = cs.color;
                const m = c && c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
                if (m) {
                    const r = +m[1], g = +m[2], b = +m[3];
                    if (g > 120 && g > r + 30 && g > b + 30) return true;
                }
            } catch (e) { }
        }
        return false;
    }

    /* ============================================================
     *  导航：下一页 / 继续下一章
     * ============================================================ */

    // 找"下一页"按钮（底部导航栏右侧）
    function findNextButton() {
        // 1. 按关键词文本找
        const byText = findByKeywords(CONFIG.nextKeywords, null, null);
        if (byText && isVisible(byText)) return byText;
        // 2. 按选择器找，并过滤出含箭头/文本的
        const els = firstMatch(CONFIG.nextSelectors, true);
        for (const el of els) {
            const txt = (el.textContent || '').trim();
            if (CONFIG.nextKeywords.some(k => txt.includes(k))) return el;
        }
        return null;
    }

    // 找"继续下一章"按钮（弹窗内）
    function findNextChapterButton() {
        return findByKeywords(CONFIG.nextChapterKeywords, null, null);
    }

    // 核心：直接点击目录栏中"当前项的下一个 page"（更可靠，不依赖底部按钮）
    // 返回 true 表示成功点击了下一项
    function clickNextCatalogPage() {
        const pages = getAllPages();
        if (!pages.length) return false;
        const cur = getCurrentPageName();
        let idx = -1;
        if (cur) {
            idx = pages.indexOf(cur);
        }
        const next = pages[idx + 1];
        if (next && next !== cur) {
            clickEl(next);
            log('🖱 已点击目录下一项：', (next.textContent || '').trim().slice(0, 30));
            return true;
        }
        return false;
    }

    async function clickNext() {
        // 优先用底部"下一页"按钮
        const btn = findNextButton();
        if (btn && isVisible(btn)) {
            clickEl(btn);
            log('➡️ 已点击「下一页」');
            await sleep(CONFIG.actionInterval);
            return true;
        }
        // 兜底：直接点击目录下一项
        if (clickNextCatalogPage()) {
            await sleep(CONFIG.actionInterval);
            return true;
        }
        return false;
    }

    async function clickNextChapter() {
        const btn = findNextChapterButton();
        if (!btn || !isVisible(btn)) {
            return false;
        }
        clickEl(btn);
        log('📖 已点击「继续下一章」');
        await sleep(CONFIG.actionInterval);
        return true;
    }

    /* ============================================================
     *  主流程
     * ============================================================ */

    let running = false;
    let stopped = false;

    async function mainLoop() {
        running = true;
        stopped = false;
        log('🚀 开始自动播放');

        let noProgress = 0;

        while (!stopped) {
            let progressed = false;

            // ---- 阶段 1：若出现"继续下一章"弹窗，优先点击 ----
            const ncBtn = await waitFor(() => findNextChapterButton(), 1500);
            if (ncBtn && isVisible(ncBtn)) {
                await clickNextChapter();
                noProgress = 0;
                await sleep(CONFIG.actionInterval);
                continue;
            }

            // ---- 阶段 2：当前小节是否已完成？是则点"下一页" ----
            const done = await waitFor(() => isCurrentDone(), 2000);
            if (done) {
                log('✔ 当前小节已完成，点击「下一页」');
                const ok = await clickNext();
                if (ok) {
                    progressed = true;
                    noProgress = 0;
                    await sleep(CONFIG.actionInterval);
                    continue;
                }
                // 点不到下一页，可能本章已结束 → 等待下一章弹窗
                await sleep(2000);
                continue;
            }

            // ---- 阶段 3：未完成 → 找视频并确保播放 ----
            const video = await waitFor(() => getVideo(), CONFIG.waitForVideoTimeout);
            if (!video) {
                // 可能不是视频任务（如 ppt / 文档）——直接翻页，让平台自己判定/计时
                log('ℹ️ 未找到视频，可能是 ppt/文档类任务，直接翻下一页');
                const ok = await clickNext();
                if (ok) { progressed = true; noProgress = 0; }
                else {
                    // 连目录下一项都点不动，说明已到本章末尾
                    log('ℹ️ 无法翻页，可能本章已结束');
                }
                await sleep(CONFIG.actionInterval);
                noProgress++;
                if (noProgress >= CONFIG.maxNoProgress) {
                    warn('⚠️ 连续多轮无进展，可能已全部完成或页面异常，停止');
                    break;
                }
                continue;
            }

            // 确保播放
            await ensurePlaying(video);
            log('▶️ 视频播放中（倍速由 Global Speed 控制）');

            // ---- 阶段 4：等待播放结束 ----
            const ended = await waitVideoEnd(video);
            if (ended) {
                log('⏹️ 视频播放结束，等待完成标记出现');
                // 等待"已看完"标记或目录对勾出现
                await waitFor(() => isCurrentDone(), CONFIG.waitForDoneTimeout);
                await sleep(1000);
                progressed = true;
                noProgress = 0;
            } else {
                warn('⏱ 视频等待超时，尝试继续');
                noProgress++;
            }
            await sleep(CONFIG.actionInterval);
        }

        running = false;
        log('🛑 自动播放结束');
    }

    // 等待视频播放结束
    async function waitVideoEnd(video, timeoutMs = 7200000) {
        if (!video) return false;
        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => { if (!settled) { settled = true; cleanup(); resolve(ok); } };

            const onEnded = () => finish(true);
            const onPause = () => {
                const dur = video.duration || 0;
                const cur = video.currentTime || 0;
                if (dur > 0 && (dur - cur) < CONFIG.endThresholdSec) finish(true);
            };

            const timer = setInterval(() => {
                const dur = video.duration || 0;
                const cur = video.currentTime || 0;
                if (dur > 0 && (dur - cur) < CONFIG.endThresholdSec) finish(true);
                // 额外：若出现"已看完"标记，直接判定结束
                if (isCurrentDone()) finish(true);
            }, 2000);

            const timeout = setTimeout(() => finish(false), timeoutMs);

            function cleanup() {
                clearInterval(timer);
                clearTimeout(timeout);
                video.removeEventListener('ended', onEnded);
                video.removeEventListener('pause', onPause);
            }

            video.addEventListener('ended', onEnded);
            video.addEventListener('pause', onPause);
        });
    }

    /* ============================================================
     *  悬浮控制面板
     * ============================================================ */

    function buildPanel() {
        if (!CONFIG.showPanel) return;
        const panel = document.createElement('div');
        panel.style.cssText = [
            'position: fixed', 'top: 20px', 'right: 20px', 'z-index: 2147483647',
            'display: flex', 'flex-direction: column', 'gap: 8px',
            'padding: 12px', 'background: rgba(30,30,30,0.92)', 'border-radius: 10px',
            'box-shadow: 0 4px 16px rgba(0,0,0,0.4)', 'font-family: sans-serif'
        ].join(';');

        const title = document.createElement('div');
        title.textContent = '优学院自动播放';
        title.style.cssText = 'color:#fff;font-size:13px;font-weight:bold;text-align:center;';

        const status = document.createElement('div');
        status.textContent = '就绪';
        status.style.cssText = 'color:#9f9;font-size:11px;text-align:center;';

        const btnStart = document.createElement('button');
        btnStart.textContent = '▶ 开始';
        const btnStop = document.createElement('button');
        btnStop.textContent = '⏹ 停止';
        const style = (b) => b.style.cssText = [
            'padding:6px 12px', 'border:none', 'border-radius:6px', 'cursor:pointer',
            'font-size:12px', 'color:#fff', 'background:#ff6b35'
        ].join(';');
        style(btnStart); style(btnStop);

        btnStart.onclick = () => {
            if (!running) {
                status.textContent = '运行中…';
                status.style.color = '#ff6b35';
                mainLoop();
            }
        };
        btnStop.onclick = () => {
            stopped = true;
            running = false;
            status.textContent = '已停止';
            status.style.color = '#999';
        };

        panel.appendChild(title);
        panel.appendChild(status);
        panel.appendChild(btnStart);
        panel.appendChild(btnStop);
        document.body.appendChild(panel);
    }

    /* ============================================================
     *  启动
     * ============================================================ */

    function init() {
        buildPanel();
        log('脚本已加载。', CONFIG.autoStart ? '自动开始' : '请点击右上角面板「▶ 开始」');
        if (CONFIG.autoStart) {
            setTimeout(() => mainLoop(), 2000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
