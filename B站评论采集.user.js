// ==UserScript==
// @name         B站评论采集
// @namespace    https://github.com/CodePorject
// @version      1.0
// @description  采集B站视频评论，支持翻页浏览与排序。
// @author       CodePorject
// @match        *://*.bilibili.com/video/*
// @match        *://*.bilibili.com/bangumi/play/*
// @match        *://*.bilibili.com/list/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    let allComments = []; 
    let filteredComments = []; 
    let isCrawling = false;
    let nextOffset = 0;
    let requestCount = 0;
    let currentPs = 1;
    let oid = "";
    let totalCollectedCount = 0; 
    let seenRpids = new Set();
    let duplicatePages = 0;
    let shadowRoot;

    // 重试控制
    let retryCount = 0;
    const MAX_RETRIES = 5; 

    // 浏览面板状态
    let sandboxCurrentPage = 1;
    const itemsPerPage = 15;
    let currentSortMode = 'likes'; 
    let currentSearchQuery = '';   

    // --- 1. 获取视频 OID ---
    async function getOid() {
        if (window.__INITIAL_STATE__?.aid) return window.__INITIAL_STATE__.aid;
        if (window.__INITIAL_STATE__?.videoData?.aid) return window.__INITIAL_STATE__.videoData.aid;

        const urlMatch = window.location.href.match(/video\/(BV[a-zA-Z0-9]+)/);
        if (urlMatch && urlMatch[1]) {
            try {
                const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${urlMatch[1]}`, {
                    credentials: 'include',
                    headers: {
                        'Referer': window.location.href,
                        'Origin': 'https://www.bilibili.com'
                    }
                });
                const json = await res.json();
                if (json.code === 0 && json.data?.aid) return json.data.aid.toString();
            } catch (e) { console.error("BV转AID失败", e); }
        }
        return null;
    }

    // --- 2. 面板 UI ---
    function createUI() {
        if (document.getElementById('bili-sandbox-crawler')) return;

        const container = document.createElement('div');
        container.id = 'bili-sandbox-crawler';
        document.body.appendChild(container);
        shadowRoot = container.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            .panel {
                position: fixed; top: 140px; right: 20px; z-index: 999999;
                background: #ffffff; border: 1px solid #e3e8ec; border-radius: 12px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.15); padding: 14px; width: 230px;
                font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #18191c;
                transition: all 0.25s ease;
            }
            .panel.minimized {
                width: 44px; height: 44px; border-radius: 50%; padding: 0;
                top: auto; bottom: 30px; right: 30px;
                background: #00aeec; color: white; cursor: pointer;
                border-color: #00aeec; box-shadow: 0 4px 12px rgba(0,174,236,0.4);
                display: flex; align-items: center; justify-content: center;
            }
            .panel.minimized .body-wrap { display: none; }
            .panel.minimized .title-row { display: none; }
            .panel.minimized .min-btn-inner { display: block; }
            .min-btn-inner { display: none; font-size: 18px; font-weight: bold; line-height: 1; }
            .title-row { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f1f2f3; padding-bottom: 6px; margin-bottom: 8px; }
            .title { font-weight: bold; color: #00aeec; font-size: 14px; }
            .status { font-size: 12px; color: #61666d; margin-bottom: 12px; line-height: 1.5; min-height: 36px; white-space: pre-line; }
            .btn { width: 100%; padding: 8px; border: none; border-radius: 6px; color: white; font-weight: bold; cursor: pointer; margin-bottom: 6px; font-size: 12px; transition: background 0.2s; }
            .btn-start { background-color: #00aeec; }
            .btn-start:hover { background-color: #00b5e5; }
            .btn-load { background-color: #ff6699; cursor: pointer; display: none; }
            .btn-active { display: block !important; }
        `;

        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.innerHTML = `
            <div class="min-btn-inner">评</div>
            <div class="title-row">
                <div class="title">B站评论采集 v1.0</div>
                <button id="btn-minimize" title="最小化" style="background:none; border:none; cursor:pointer; font-size:18px; color:#9499a0; padding:0 6px; line-height:1; font-weight:bold;">─</button>
            </div>
            <div class="body-wrap">
                <div class="status" id="crawl-status">就绪</div>
                <button class="btn btn-start" id="btn-start">开始采集</button>
                <button class="btn btn-load" id="btn-render">浏览评论</button>
            </div>
        `;

        shadowRoot.appendChild(style);
        shadowRoot.appendChild(panel);

        shadowRoot.getElementById('btn-start').onclick = startCrawling;
        shadowRoot.getElementById('btn-render').onclick = () => { 
            sandboxCurrentPage = 1; 
            currentSearchQuery = ''; 
            executeDataProcess(); 
            openPureSandboxUI(); 
        };

        const minimizeBtn = shadowRoot.getElementById('btn-minimize');
        const mainPanel = shadowRoot.querySelector('.panel');
        minimizeBtn.onclick = (e) => {
            e.stopPropagation();
            mainPanel.classList.toggle('minimized');
        };
        mainPanel.onclick = (e) => {
            if (mainPanel.classList.contains('minimized')) {
                mainPanel.classList.remove('minimized');
            }
        };
    }

    // --- 3. 分页爬取 ---
    function getDynamicDelay() {
        const minBase = requestCount < 10 ? 3000 : 2000;
        const maxBase = requestCount < 10 ? 5000 : 4000;
        const baseDelay = Math.floor(Math.random() * (maxBase - minBase)) + minBase;
        const pageFatigue = Math.min(requestCount * 80, 3000);
        const jitter = Math.floor(Math.random() * 800);
        return baseDelay + pageFatigue + jitter;
    }

    function fetchNextPage() {
        if (!isCrawling) return;

        const statusText = shadowRoot.getElementById('crawl-status');
        statusText.style.color = '#61666d';
        statusText.innerText = `采集进度：第 ${requestCount + 1} 页\n已获取 ${allComments.length} 条主评论（含楼中楼共 ${totalCollectedCount} 条）`;

        const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${oid}&mode=2&next=${nextOffset}&ps=${currentPs}&plat=2`;

        fetch(url, {
            credentials: 'include',
            headers: {
                'Referer': window.location.href,
                'Origin': 'https://www.bilibili.com'
            }
        })
            .then(res => res.json())
            .then(json => {
                if (json.code !== 0) {
                    handleCrawlError(`B站响应码错误(${json.code})`);
                    return;
                }

                if (json.data) {
                    retryCount = 0; 

                    const cursor = json.data.cursor;
                    const replies = json.data.replies;

                    // 先判断是否全重复（避免先加 seenRpids 再检查的 bug）
                    const isEmpty = !replies || replies.length === 0;
                    const allDuplicate = !isEmpty && replies.every(r => seenRpids.has(r.rpid));

                    if (isEmpty || allDuplicate) {
                        duplicatePages++;
                        if (duplicatePages >= 3) {
                            finishCrawling(true);
                        } else {
                            nextOffset = cursor && cursor.next != null ? cursor.next : nextOffset + currentPs;
                            requestCount++;
                            setTimeout(fetchNextPage, getDynamicDelay());
                        }
                        return;
                    }

                    duplicatePages = 0;

                    if (replies && replies.length > 0) {
                        replies.forEach(reply => {
                            if (seenRpids.has(reply.rpid)) return;
                            seenRpids.add(reply.rpid);

                            let pics = [];
                            if (reply.content?.pictures && Array.isArray(reply.content.pictures)) {
                                pics = reply.content.pictures.map(p => p.img_src);
                            }

                            allComments.push({
                                rpid: reply.rpid,
                                likes: parseInt(reply.like) || 0,
                                isTop: reply.is_top || !!(reply.state & 1),
                                username: reply.member?.uname || "未知用户",
                                avatar: reply.member?.avatar || "",
                                content: reply.content?.message || "",
                                ctime: reply.ctime,
                                rcount: reply.rcount || 0,
                                pictures: pics 
                            });

                            totalCollectedCount += 1;
                            if (reply.rcount) {
                                totalCollectedCount += parseInt(reply.rcount);
                            }
                        });
                    }

                    // 自适应 ps（B 站 ps 上限 30）
                    if (replies.length < 30) {
                        currentPs = Math.min(currentPs * 2, 30);
                    } else if (currentPs > 30) {
                        currentPs = 30;
                    }
                    nextOffset = cursor && cursor.next != null ? cursor.next : nextOffset + currentPs;
                    requestCount++;
                    setTimeout(fetchNextPage, getDynamicDelay());
                } else {
                    handleCrawlError("回执体数据缺失");
                }
            })
            .catch(err => {
                handleCrawlError("网络请求被挂起/阻断");
            });
    }

    function handleCrawlError(reason) {
        if (!isCrawling) return;

        const statusText = shadowRoot.getElementById('crawl-status');
        retryCount++;

        if (retryCount <= MAX_RETRIES) {
            // 指数退避
            const backoffTime = Math.pow(2, retryCount) * 2000; 
            statusText.style.color = '#ffaa00';
            statusText.innerText = `请求被限(${reason})\n${(backoffTime/1000)} 秒后重试`;
            
            setTimeout(fetchNextPage, backoffTime);
        } else {
            finishCrawling(false, "请求失败次数过多，已停止");
        }
    }

    async function startCrawling() {
        if (isCrawling) return;
        shadowRoot.getElementById('crawl-status').innerText = "正在获取视频信息...";
        oid = await getOid();
        if (!oid) {
            shadowRoot.getElementById('crawl-status').innerText = "错误：视频ID解析受阻";
            return;
        }
        allComments = [];
        seenRpids = new Set();
        nextOffset = 0;
        currentPs = 1;
        requestCount = 0;
        totalCollectedCount = 0; 
        retryCount = 0; 
        duplicatePages = 0;
        isCrawling = true;

        const startBtn = shadowRoot.getElementById('btn-start');
        startBtn.disabled = true;
        startBtn.style.backgroundColor = '#9499a0';
        startBtn.innerText = '采集中...';

        fetchNextPage();
    }

    function finishCrawling(isSuccess, errorMsg = "") {
        isCrawling = false;
        const statusText = shadowRoot.getElementById('crawl-status');
        const startBtn = shadowRoot.getElementById('btn-start');
        const renderBtn = shadowRoot.getElementById('btn-render');

        startBtn.disabled = false;
        startBtn.style.backgroundColor = '#00aeec';
        startBtn.innerText = '开始采集';

        if (isSuccess) {
            statusText.innerText = `采集完成\n共获取 ${allComments.length} 条主评论（含楼中楼共 ${totalCollectedCount} 条）`;
            statusText.style.color = '#46c61a';
        } else {
            statusText.innerText = `提示：${errorMsg}。\n已获取 ${allComments.length} 条主评论。`;
            statusText.style.color = '#ff6699';
        }

        if (allComments.length > 0) {
            renderBtn.classList.add('btn-active');
            renderBtn.innerText = `浏览评论 (${allComments.length})`;
        }
    }

    // --- 4. 数据处理与排序 ---
    function executeDataProcess() {
        if (currentSearchQuery.trim() !== '') {
            const query = currentSearchQuery.toLowerCase().trim();
            filteredComments = allComments.filter(item => 
                item.content.toLowerCase().includes(query) || 
                item.username.toLowerCase().includes(query)
            );
        } else {
            filteredComments = [...allComments];
        }

        filteredComments.sort((a, b) => {
            if (a.isTop && !b.isTop) return -1;
            if (!a.isTop && b.isTop) return 1;
            return currentSortMode === 'likes' ? b.likes - a.likes : b.rcount - a.rcount;
        });
    }

    function generateSliderPageNumbers(current, total) {
        const pages = [];
        if (total <= 1) return [1];
        pages.push(1);
        let start = Math.max(2, current - 3);
        let end = Math.min(total - 1, current + 3);
        if (start > 2) pages.push('...');
        for (let i = start; i <= end; i++) pages.push(i);
        if (end < total - 1) pages.push('...');
        pages.push(total);
        return pages;
    }

    // --- 5. 图片灯箱 ---
    function openImageLightbox(imgList, activeIndex) {
        let lightbox = document.getElementById('sandbox-lightbox-overlay');
        if (lightbox) lightbox.remove();

        lightbox = document.createElement('div');
        lightbox.id = 'sandbox-lightbox-overlay';
        lightbox.style = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(12, 12, 14, 0.95); z-index: 2000000;
            display: flex; flex-direction: column; justify-content: center; align-items: center;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;

        const topBar = document.createElement('div');
        topBar.style = 'position: absolute; top: 20px; right: 30px; display: flex; align-items: center; gap: 20px; z-index: 2000002;';
        topBar.innerHTML = `
            <span id="lightbox-counter" style="color: #9499a0; font-size: 15px; font-weight: bold; background: rgba(255,255,255,0.08); padding: 4px 12px; border-radius: 20px;"></span>
            <button id="lightbox-close-btn" style="background: none; border: none; color: #fff; font-size: 32px; cursor: pointer; transition: color 0.2s; line-height: 1;">✕</button>
        `;
        lightbox.appendChild(topBar);

        const imgWrapper = document.createElement('div');
        imgWrapper.style = 'max-width: 85%; max-height: 75%; display: flex; justify-content: center; align-items: center; position: relative;';
        const mainImg = document.createElement('img');
        mainImg.style = 'max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);';
        imgWrapper.appendChild(mainImg);
        lightbox.appendChild(imgWrapper);

        const bottomBar = document.createElement('div');
        bottomBar.style = 'margin-top: 25px; display: flex; gap: 15px; z-index: 2000002;';
        lightbox.appendChild(bottomBar);

        let currentIndex = activeIndex;

        function updateLightboxView() {
            mainImg.src = imgList[currentIndex];
            const counter = lightbox.querySelector('#lightbox-counter');
            counter.innerText = `图片: ${currentIndex + 1} / ${imgList.length}`;

            if (imgList.length <= 1) {
                bottomBar.style.display = 'none';
            } else {
                bottomBar.style.display = 'flex';
                bottomBar.innerHTML = `
                    <button id="light-prev" style="padding: 6px 16px; background: rgba(255,255,255,0.15); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 13px;">◀ 上一张</button>
                    <button id="light-next" style="padding: 6px 16px; background: rgba(255,255,255,0.15); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 13px;">下一张 ▶</button>
                `;

                bottomBar.querySelector('#light-prev').onclick = (e) => {
                    e.stopPropagation();
                    currentIndex = (currentIndex - 1 + imgList.length) % imgList.length;
                    updateLightboxView();
                };
                bottomBar.querySelector('#light-next').onclick = (e) => {
                    e.stopPropagation();
                    currentIndex = (currentIndex + 1) % imgList.length;
                    updateLightboxView();
                };
            }
        }

        const closeAction = () => lightbox.remove();
        topBar.querySelector('#lightbox-close-btn').onclick = closeAction;
        lightbox.onclick = closeAction;
        mainImg.onclick = (e) => e.stopPropagation();

        updateLightboxView();
        document.body.appendChild(lightbox);
    }

    // --- 6. 子评论加载 ---
    function fetchSubCommentsPaged(rootId, pageNum, subContainer, loadBtnContainer, triggerBtn, mainRowNode, originalReplyCount) {
        subContainer.querySelectorAll('.sub-reply-item-row').forEach(el => el.remove());

        let tip = subContainer.querySelector('.sub-loading-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'sub-loading-tip';
            tip.style = 'color: #00aeec; font-size:12px; padding: 10px 0; font-weight:bold; text-align:center;';
            subContainer.appendChild(tip);
        }
        tip.style.display = 'block';
        tip.innerText = `🔄 正在读取楼中楼第 ${pageNum} 页...`;
        
        loadBtnContainer.style.display = 'none';

        const subUrl = `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${oid}&root=${rootId}&pn=${pageNum}&ps=10`;

        fetch(subUrl, {
            credentials: 'include',
            headers: {
                'Referer': window.location.href,
                'Origin': 'https://www.bilibili.com'
            }
        })
            .then(res => res.json())
            .then(json => {
                tip.style.display = 'none';
                if (json.code === 0 && json.data && json.data.replies) {
                    const subReplies = json.data.replies;
                    const pageInfo = json.data.page;
                    const subTotalPages = Math.ceil(pageInfo.count / pageInfo.size);

                    subReplies.forEach(sub => {
                        let subPics = [];
                        if (sub.content?.pictures && Array.isArray(sub.content.pictures)) {
                            subPics = sub.content.pictures.map(p => p.img_src);
                        }

                        const subRow = document.createElement('div');
                        subRow.className = 'sub-reply-item-row';
                        subRow.style = 'padding: 12px 0; border-bottom: 1px dashed #e3e8ec; display: flex; align-items: flex-start; font-size: 13px;';
                        subRow.innerHTML = `
                            <div style="margin-right: 12px;">
                                <img src="${sub.member?.avatar}@32w_32h_1c.webp" style="width: 32px; height: 32px; border-radius: 50%;" onerror="this.src='https://static.hdslb.com/images/member/noface.gif'">
                            </div>
                            <div style="flex: 1;">
                                <div style="color: #5090cc; font-weight: bold; margin-bottom: 2px;">${sub.member?.uname || "未知用户"}</div>
                                <div style="color: #18191c; line-height: 20px; white-space: pre-wrap; margin: 4px 0;">${sub.content?.message || ""}</div>
                                
                                ${subPics.length > 0 ? `
                                    <div style="display:flex; gap:8px; flex-wrap:wrap; margin:8px 0;">
                                        ${subPics.map((imgUrl, idx) => `<img src="${imgUrl}@200w_200h_1c.webp" class="sandbox-sub-zoom-img" data-idx="${idx}" style="max-width:120px; border-radius:6px; cursor:zoom-in; box-shadow:0 1px 4px rgba(0,0,0,0.1);">`).join('')}
                                    </div>
                                ` : ''}

                                <div style="color: #9499a0; font-size: 11px; display: flex; gap: 15px; align-items: center; margin-top:4px;">
                                    <span>${new Date(sub.ctime * 1000).toLocaleString()}</span>
                                    <span style="color: #74787c;">👍 赞: ${sub.like || 0}</span>
                                </div>
                            </div>
                        `;
                        subContainer.insertBefore(subRow, loadBtnContainer);

                        subRow.querySelectorAll('.sandbox-sub-zoom-img').forEach(img => {
                            img.onclick = () => {
                                const activeIdx = parseInt(img.getAttribute('data-idx'));
                                openImageLightbox(subPics, activeIdx);
                            };
                        });
                    });

                    loadBtnContainer.style.display = 'block';
                    
                    let phtml = `<div style="display: flex; align-items: center; gap: 4px; margin-top: 8px; flex-wrap: wrap;">`;
                    phtml += `<button class="sub-p-act" data-p="${pageNum - 1}" ${pageNum === 1 ? 'disabled style="background:#f1f2f3;color:#ccc;cursor:not-allowed;padding:3px 8px;font-size:11px;border:1px solid #e3e8ec;"' : 'style="cursor:pointer;padding:3px 8px;font-size:11px;background:#fff;border:1px solid #ccd0d7;border-radius:4px;"'}>‹ 上一页</button>`;

                    const sliderPages = generateSliderPageNumbers(pageNum, subTotalPages);
                    sliderPages.forEach(p => {
                        if (p === '...') {
                            phtml += `<span style="font-size:11px; color:#9499a0; padding:0 3px;">...</span>`;
                        } else if (p === pageNum) {
                            phtml += `<button style="padding:3px 8px; font-size:11px; background:#00aeec; color:#fff; border:1px solid #00aeec; border-radius:4px; font-weight:bold;">${p}</button>`;
                        } else {
                            phtml += `<button class="sub-p-act" data-p="${p}" style="padding:3px 8px; font-size:11px; background:#fff; color:#555; border:1px solid #ccd0d7; border-radius:4px; cursor:pointer;">${p}</button>`;
                        }
                    });

                    phtml += `<button class="sub-p-act" data-p="${pageNum + 1}" ${pageNum === subTotalPages ? 'disabled style="background:#f1f2f3;color:#ccc;cursor:not-allowed;padding:3px 8px;font-size:11px;border:1px solid #e3e8ec;"' : 'style="cursor:pointer;padding:3px 8px;font-size:11px;background:#fff;border:1px solid #ccd0d7;border-radius:4px;"'}>下一页 ›</button>`;
                    phtml += `<button id="sub-close-btn" style="padding: 3px 10px; background: #9499a0; color: white; border: none; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: bold; margin-left: 10px;">▲ 收起</button>`;
                    phtml += `</div>`;

                    loadBtnContainer.innerHTML = phtml;

                    loadBtnContainer.querySelectorAll('.sub-p-act').forEach(btn => {
                        if (!btn.disabled) {
                            btn.onclick = () => {
                                const targetP = parseInt(btn.getAttribute('data-p'));
                                fetchSubCommentsPaged(rootId, targetP, subContainer, loadBtnContainer, triggerBtn, mainRowNode, originalReplyCount);
                                mainRowNode.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            };
                        }
                    });

                    const closeSubPanelAction = () => {
                        subContainer.querySelectorAll('.sub-reply-item-row').forEach(el => el.remove());
                        subContainer.style.display = 'none';
                        triggerBtn.innerHTML = `💬 查看回复 (${originalReplyCount}条)`;
                        triggerBtn.style.backgroundColor = '#f1f2f3';
                        triggerBtn.style.color = '#61666d';
                        triggerBtn.setAttribute('data-state', 'closed'); 
                    };

                    loadBtnContainer.querySelector('#sub-close-btn').onclick = closeSubPanelAction;

                } else {
                    loadBtnContainer.style.display = 'block';
                    loadBtnContainer.innerHTML = `<span style="font-size:12px; color:#9499a0;">暂无回复数据</span>`;
                }
            })
            .catch(err => {
                loadBtnContainer.style.display = 'block';
                loadBtnContainer.innerHTML = `<span style="font-size:12px; color:#ff6699;">数据读取受阻</span>`;
            });
    }

    // --- 7. 全屏浏览界面 ---
    function openPureSandboxUI() {
        if (allComments.length === 0) return;

        let sandbox = document.getElementById('bili-pure-sandbox');
        if (sandbox) sandbox.remove();

        sandbox = document.createElement('div');
        sandbox.id = 'bili-pure-sandbox';
        sandbox.style = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(255, 255, 255, 0.99); backdrop-filter: blur(15px);
            z-index: 1000000; overflow-y: auto; box-sizing: border-box;
            padding: 30px 15% 100px 15%; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;

        const totalPages = Math.max(1, Math.ceil(filteredComments.length / itemsPerPage));
        if (sandboxCurrentPage > totalPages) sandboxCurrentPage = totalPages;
        
        const header = document.createElement('div');
        header.style = 'border-bottom: 2px solid #00aeec; padding-bottom: 20px; margin-bottom: 20px;';
        header.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div>
                    <h2 style="margin: 0; color: #18191c; font-size: 22px; display:flex; align-items:center; gap:10px;">B站评论浏览 <span style="font-size:12px; color:#fff; background:#46c61a; padding:2px 6px; border-radius:4px; font-weight:normal;">v1.0</span></h2>
                    <p style="margin: 6px 0 0 0; color: #61666d; font-size: 13px;">
                        共 ${totalCollectedCount} 条 | 
                        匹配 <span style="color:#ff6699; font-weight:bold;">${filteredComments.length}</span> 条 | 
                        第 ${sandboxCurrentPage} / ${totalPages} 页
                    </p>
                </div>
                <button id="close-sandbox-btn" style="padding: 10px 20px; background: #ff6699; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px; box-shadow: 0 4px 10px rgba(255,102,153,0.15);">关闭</button>
            </div>
            
            <div style="margin-top: 18px; display: flex; gap: 15px; align-items: center; background: #f6f7f9; padding: 12px; border-radius: 8px; border: 1px solid #e3e8ec;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size:13px; font-weight:bold; color:#18191c;">排序:</span>
                    <button id="sort-by-likes" style="padding: 5px 12px; font-size:12px; font-weight:bold; border-radius:4px; border:1px solid #ccd0d7; cursor:pointer; transition:all 0.2s; ${currentSortMode==='likes'?'background:#00aeec;color:white;border-color:#00aeec;':'background:#fff;color:#555;'}">按点赞排序</button>
                    <button id="sort-by-replies" style="padding: 5px 12px; font-size:12px; font-weight:bold; border-radius:4px; border:1px solid #ccd0d7; cursor:pointer; transition:all 0.2s; ${currentSortMode==='replies'?'background:#00aeec;color:white;border-color:#00aeec;':'background:#fff;color:#555;'}">按回复排序</button>
                </div>
                <div style="flex: 1; display: flex; align-items: center; gap: 8px; margin-left: 20px;">
                    <span style="font-size:13px; font-weight:bold; color:#18191c;">搜索:</span>
                    <input type="text" id="sandbox-search-input" value="${currentSearchQuery}" placeholder="搜索内容关键字或用户名，按回车查找..." style="flex:1; padding:6px 12px; font-size:12px; border:1px solid #ccd0d7; border-radius:6px; outline:none;">
                </div>
            </div>
        `;
        sandbox.appendChild(header);

        sandbox.querySelector('#sort-by-likes').onclick = () => { if(currentSortMode!=='likes'){ currentSortMode = 'likes'; sandboxCurrentPage=1; executeDataProcess(); openPureSandboxUI(); } };
        sandbox.querySelector('#sort-by-replies').onclick = () => { if(currentSortMode!=='replies'){ currentSortMode = 'replies'; sandboxCurrentPage=1; executeDataProcess(); openPureSandboxUI(); } };
        
        const srcInput = sandbox.querySelector('#sandbox-search-input');
        srcInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                currentSearchQuery = srcInput.value;
                sandboxCurrentPage = 1;
                executeDataProcess();
                openPureSandboxUI();
            }
        };

        const startIndex = (sandboxCurrentPage - 1) * itemsPerPage;
        const pageData = filteredComments.slice(startIndex, startIndex + itemsPerPage);

        const listWrapper = document.createElement('div');
        if (pageData.length === 0) {
            listWrapper.innerHTML = `<div style="text-align:center; padding:100px 0; color:#9499a0; font-size:14px;">未找到匹配的评论</div>`;
        } else {
            pageData.forEach((item, index) => {
                const absoluteIndex = startIndex + index + 1;
                const row = document.createElement('div');
                row.className = 'main-comment-wrapper-node';
                row.style = 'padding: 24px 0; border-bottom: 1px solid #e3e8ec; display: flex; flex-direction: column; scroll-margin-top: 20px;';
                
                row.innerHTML = `
                    <div style="display: flex; align-items: flex-start; width: 100%;">
                        <div style="font-weight: bold; color: #9499a0; font-size: 15px; width: 45px; padding-top: 2px;">#${absoluteIndex}</div>
                        <div style="margin-right: 18px;">
                            <img src="${item.avatar}@48w_48h_1c.webp" style="width: 46px; height: 46px; border-radius: 50%; box-shadow: 0 2px 6px rgba(0,0,0,0.05);" onerror="this.src='https://static.hdslb.com/images/member/noface.gif'">
                        </div>
                        <div style="flex: 1;">
                            <div style="color: #61666d; font-size: 14px; font-weight: bold; display: flex; align-items: center; gap: 8px;">
                                <span style="color: #18191c;">${item.username}</span>
                                ${item.isTop ? '<span style="color:white; background:#ff6699; border-radius:4px; padding:1px 5px; font-size:11px; font-weight:normal;">UP主置顶</span>' : ''}
                            </div>
                            <div style="font-size: 15px; line-height: 26px; color: #18191c; white-space: pre-wrap; margin: 8px 0; letter-spacing: 0.3px;">${item.content}</div>
                            
                            ${item.pictures && item.pictures.length > 0 ? `
                                <div style="display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0;">
                                    ${item.pictures.map((imgUrl, idx) => `<img src="${imgUrl}@240w_240h_1c.webp" class="sandbox-main-zoom-img" data-idx="${idx}" style="max-width: 160px; border-radius: 8px; cursor: zoom-in; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 1px solid #e3e8ec;">`).join('')}
                                </div>
                            ` : ''}

                            <div style="color: #9499a0; font-size: 12px; display: flex; align-items: center; gap: 24px; margin-bottom: 10px; margin-top: 6px;">
                                <span>发布时间：${new Date(item.ctime * 1000).toLocaleString()}</span>
                                <span style="color: #00aeec; font-weight: bold; font-size: 13px; background: rgba(0,174,236,0.06); padding: 2px 8px; border-radius: 20px;">👍 赞: ${item.likes >= 10000 ? (item.likes/10000).toFixed(1)+'万' : item.likes}</span>
                                <span style="color: #74c9e5; font-weight: bold; font-size: 13px; background: rgba(115,201,229,0.08); padding: 2px 8px; border-radius: 20px;">💬 回复数: ${item.rcount}</span>
                            </div>
                            
                            ${item.rcount > 0 ? `<button class="show-replies-trigger-btn" data-state="closed" style="padding: 6px 14px; background: #f1f2f3; color: #61666d; border: none; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.2s;">💬 查看回复 (${item.rcount}条)</button>` : ''}
                            
                            <div class="sub-comments-container" style="background: #f7f8fa; border-radius: 8px; padding: 0 16px; margin-top: 12px; display: none; width: 95%;">
                                <div class="sub-control-btn-container-at-bottom" style="padding: 12px 0; text-align: left;"></div>
                            </div>
                        </div>
                    </div>
                `;
                
                const triggerBtn = row.querySelector('.show-replies-trigger-btn');
                const subContainer = row.querySelector('.sub-comments-container');
                const bottomCtrlBox = row.querySelector('.sub-control-btn-container-at-bottom');
                
                if (item.pictures && item.pictures.length > 0) {
                    row.querySelectorAll('.sandbox-main-zoom-img').forEach(img => {
                        img.onclick = () => {
                            const currentIdx = parseInt(img.getAttribute('data-idx'));
                            openImageLightbox(item.pictures, currentIdx);
                        };
                    });
                }

                if (triggerBtn && subContainer) {
                    triggerBtn.onclick = function() {
                        const currentState = triggerBtn.getAttribute('data-state');

                        if (currentState === 'closed') {
                            triggerBtn.innerHTML = `▲ 收起评论`;
                            triggerBtn.style.backgroundColor = '#9499a0';
                            triggerBtn.style.color = '#ffffff';
                            triggerBtn.setAttribute('data-state', 'opened');

                            subContainer.style.display = 'block';
                            fetchSubCommentsPaged(item.rpid, 1, subContainer, bottomCtrlBox, triggerBtn, row, item.rcount);
                        } else {
                            subContainer.querySelectorAll('.sub-reply-item-row').forEach(el => el.remove());
                            subContainer.style.display = 'none';

                            triggerBtn.innerHTML = `💬 查看回复 (${item.rcount}条)`;
                            triggerBtn.style.backgroundColor = '#f1f2f3';
                            triggerBtn.style.color = '#61666d';
                            triggerBtn.setAttribute('data-state', 'closed');
                        }
                    };
                }

                listWrapper.appendChild(row);
            });
        }
        sandbox.appendChild(listWrapper);

        // --- 8. 翻页 UI ---
        if (totalPages > 1) {
            const pagerContainer = document.createElement('div');
            pagerContainer.style = 'margin-top: 40px; padding: 20px 0; display: flex; justify-content: center; align-items: center; gap: 6px; border-top: 1px solid #e3e8ec; flex-wrap: wrap;';
            
            let mhtml = `<button class="m-p-act" data-p="${sandboxCurrentPage - 1}" ${sandboxCurrentPage === 1 ? 'disabled style="background:#f1f2f3;color:#bfbfbf;cursor:not-allowed;padding:6px 14px;border:1px solid #ccd0d7;border-radius:4px;font-size:13px;"' : 'style="cursor:pointer;padding:6px 14px;border:1px solid #ccd0d7;background:#fff;border-radius:4px;color:#555;font-size:13px;font-weight:bold;"'}>上一页</button>`;

            const mainSlider = generateSliderPageNumbers(sandboxCurrentPage, totalPages);
            mainSlider.forEach(p => {
                if (p === '...') {
                    mhtml += `<span style="font-size:14px; color:#9499a0; padding:0 6px;">...</span>`;
                } else if (p === sandboxCurrentPage) {
                    mhtml += `<button style="padding: 6px 14px; border: 1px solid #00aeec; background:#00aeec; color:#fff; border-radius:4px; font-size:13px; font-weight:bold;">${p}</button>`;
                } else {
                    mhtml += `<button class="m-p-act" data-p="${p}" style="padding: 6px 14px; border: 1px solid #ccd0d7; background:#fff; border-radius:4px; color:#555; font-size:13px; font-weight:bold; cursor:pointer;">${p}</button>`;
                }
            });

            mhtml += `<button class="m-p-act" data-p="${sandboxCurrentPage + 1}" ${sandboxCurrentPage === totalPages ? 'disabled style="background:#f1f2f3;color:#bfbfbf;cursor:not-allowed;padding:6px 14px;border:1px solid #ccd0d7;border-radius:4px;font-size:13px;"' : 'style="cursor:pointer;padding:6px 14px;border:1px solid #ccd0d7;background:#fff;border-radius:4px;color:#555;font-size:13px;font-weight:bold;"'}>下一页</button>`;
            pagerContainer.innerHTML = mhtml;

            pagerContainer.querySelectorAll('.m-p-act').forEach(btn => {
                if(!btn.disabled) {
                    btn.onclick = () => {
                        sandboxCurrentPage = parseInt(btn.getAttribute('data-p'));
                        openPureSandboxUI();
                        sandbox.scrollTo(0, 0); 
                    };
                }
            });

            sandbox.appendChild(pagerContainer);
        }

        document.body.appendChild(sandbox);
        document.body.style.overflow = 'hidden'; 

        sandbox.querySelector('#close-sandbox-btn').onclick = function() {
            sandbox.remove();
            document.body.style.overflow = ''; 
        };
    }

    setTimeout(createUI, 1500);
})();
