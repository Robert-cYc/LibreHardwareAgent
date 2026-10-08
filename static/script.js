const chatHistory = document.getElementById('chatHistory');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const dashboard = document.getElementById('dashboard');

const activeCharts = {}; // { identifier: chartInstance }

// Initialize GridStack
const grid = GridStack.init({
    cellHeight: '150px',
    margin: 15,
    animate: true,
    resizable: { handles: 'se, sw' } // allow resizing
});

grid.on('change', function(event, items) {
    saveLayout();
});

// WebSocket connection
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
let ws;

function connectWebSocket() {
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        const statusEl = document.getElementById('connectionStatus');
        if (statusEl) {
            if (!statusEl.textContent.includes('(')) {
                statusEl.textContent = '已連線';
            }
            statusEl.style.color = '#66fcf1';
        }
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'welcome') {
            const statusEl = document.getElementById('connectionStatus');
            if (statusEl) {
                statusEl.textContent = `已連線 (${msg.model})`;
            }
        } else if (msg.type === 'update') {
            const dataMap = msg.data;
            const now = Date.now();
            // Update all active charts
            for (const [identifier, chart] of Object.entries(activeCharts)) {
                const timeframeMs = (chart.config.options.plugins.timeframe || 15) * 60 * 1000;
                
                if (dataMap[identifier]) {
                    const point = {
                        x: dataMap[identifier].timestamp,
                        y: dataMap[identifier].value
                    };
                    
                    const dataset = chart.data.datasets[0];
                    const lastPoint = dataset.data[dataset.data.length - 1];
                    
                    if (!lastPoint || lastPoint.x !== point.x) {
                        dataset.data.push(point);
                        
                        // Dynamic Color Update
                        const newColors = getChartColors(chart.ctx, point.y, identifier);
                        dataset.backgroundColor = newColors.gradient;
                        dataset.borderColor = newColors.borderColor;
                    }
                    
                    const cutoff = now - timeframeMs;
                    
                    while (dataset.data.length > 0 && dataset.data[0].x < cutoff) {
                        dataset.data.shift();
                    }
                }
                
                chart.options.scales.x.min = now - timeframeMs;
                chart.options.scales.x.max = now;
                chart.update('none');
            }
        } else if (msg.type === 'alert') {
            // Flash red border effect
            dashboard.style.boxShadow = 'inset 0 0 50px rgba(255, 76, 76, 0.5)';
            setTimeout(() => dashboard.style.boxShadow = 'none', 1500);
            
            // Add to alert history modal
            alertsHistory.unshift({ time: new Date().toLocaleTimeString(), msg: msg.message });
            unreadAlerts++;
            updateAlertBadge();
            renderAlertHistory();
            addMessage(msg.message, 'system');
        }
    };

    ws.onclose = () => {
        const statusEl = document.getElementById('connectionStatus');
        if (statusEl) {
            statusEl.textContent = '連線中...';
            statusEl.style.color = '#ff4b4b';
        }
        console.log("WebSocket disconnected, reconnecting in 5s...");
        setTimeout(connectWebSocket, 5000);
    };
}

connectWebSocket();

function addMessage(text, sender) {
    const div = document.createElement('div');
    div.className = `message ${sender}`;
    div.textContent = text;
    chatHistory.appendChild(div);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

async function handleCommand() {
    const text = chatInput.value.trim();
    if (!text) return;

    addMessage(text, 'user');
    chatInput.value = '';
    
    showThinking();
    
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });
        
        const result = await response.json();
        
        removeThinking();
        
        if (result.status === 'error') {
            addMessage(`系統回報: ${result.message}`, 'system');
            return;
        }
        
        if (result.status === 'answer') {
            addMessage(result.message, 'system');
            return;
        }

        const { action, target, identifier, timeframe } = result;

        if (action === 'add') {
            if (activeCharts[identifier]) {
                addMessage(`圖表「${target}」已經在您的儀表板上了。`, 'system');
                return;
            }
            addMessage(`好的，正在為您產生「${target}」的趨勢圖...`, 'system');
            await createChart(identifier, target, timeframe);
        } else if (action === 'remove') {
            let targetId = identifier;
            if (!targetId) {
                // Heuristic mapping if backend didn't return an exact identifier
                targetId = Object.keys(activeCharts).find(id => id.includes(target.split('_')[0]));
            }
            
            if (targetId && activeCharts[targetId]) {
                removeChart(targetId);
                addMessage(`已成功為您移除「${target}」的圖表。`, 'system');
            } else {
                addMessage(`在目前的儀表板上找不到「${target}」圖表可供移除。`, 'system');
            }
        }

    } catch (err) {
        removeThinking();
        addMessage(`連線發生錯誤: ${err.message}`, 'system');
    }
}

async function createChart(identifier, title, timeframe, pos = { w: 4, h: 2, x: undefined, y: undefined }) {
    // Fetch historical data to prepopulate chart
    const res = await fetch(`/api/history?identifier=${encodeURIComponent(identifier)}&minutes=${timeframe}`);
    const { data } = await res.json();
    
    const formattedData = data.map(d => ({ x: d.timestamp, y: d.value }));

    // Create GridStack widget DOM structure
    const xAttr = pos.x !== undefined ? `gs-x="${pos.x}"` : '';
    const yAttr = pos.y !== undefined ? `gs-y="${pos.y}"` : '';
    
    // Sanitize identifier for DOM IDs to prevent querySelector errors in GridStack
    const safeId = identifier.replace(/[^a-zA-Z0-9]/g, '_');
    
    const widgetHtml = `
        <div class="grid-stack-item" ${xAttr} ${yAttr} gs-w="${pos.w}" gs-h="${pos.h}" id="widget-${safeId}" gs-id="${identifier}">
            <div class="grid-stack-item-content chart-container" style="display: flex; flex-direction: column;">
                <div class="chart-header">
                    <span class="chart-title">${title.toUpperCase().replace('_', ' ')}</span>
                    <button class="chart-remove" onclick="removeChart('${identifier}')" title="移除圖表">×</button>
                </div>
                <div style="flex: 1; position: relative;">
                    <canvas id="canvas-${safeId}"></canvas>
                </div>
            </div>
        </div>
    `;
    
    grid.addWidget(widgetHtml);
    const canvas = document.getElementById(`canvas-${safeId}`);

    // Initialize Chart.js
    const ctx = canvas.getContext('2d');
    
    // Set initial colors based on latest data
    const lastValue = formattedData.length > 0 ? formattedData[formattedData.length - 1].y : 0;
    const initColors = getChartColors(ctx, lastValue, identifier);

    const chart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: title,
                data: formattedData,
                borderColor: initColors.borderColor,
                backgroundColor: initColors.gradient,
                borderWidth: 2,
                pointRadius: 1,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#fff',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(31, 40, 51, 0.9)',
                    titleColor: '#fff',
                    bodyColor: '#66fcf1',
                    borderColor: 'rgba(102, 252, 241, 0.3)',
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false
                },
                timeframe: timeframe // Custom property for sliding window logic
            },
            scales: {
                x: {
                    type: 'time',
                    min: Date.now() - (timeframe * 60 * 1000),
                    max: Date.now(),
                    time: {
                        tooltipFormat: 'HH:mm:ss'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#8b8c8d',
                        maxRotation: 0,
                        autoSkipPadding: 15
                    }
                },
                y: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#8b8c8d',
                        padding: 10
                    },
                    beginAtZero: true
                }
            },
            animation: {
                duration: 0 // Disable animation on update for performance
            }
        }
    });

    activeCharts[identifier] = chart;
    saveLayout();
    updateEmptyState();
}

function removeChart(identifier) {
    if (activeCharts[identifier]) {
        activeCharts[identifier].destroy();
        delete activeCharts[identifier];
        const safeId = identifier.replace(/[^a-zA-Z0-9]/g, '_');
        const widget = document.getElementById(`widget-${safeId}`);
        if (widget) {
            grid.removeWidget(widget);
        }
        saveLayout();
        updateEmptyState();
    }
}

function saveLayout() {
    if (!grid) return;
    const savedData = [];
    grid.getGridItems().forEach(item => {
        const id = item.getAttribute('gs-id');
        const node = item.gridstackNode;
        if (activeCharts[id]) {
            savedData.push({
                identifier: id,
                title: activeCharts[id].data.datasets[0].label,
                timeframe: activeCharts[id].config.options.plugins.timeframe || 15,
                x: node.x,
                y: node.y,
                w: node.w,
                h: node.h
            });
        }
    });
    localStorage.setItem('dashboard_layout_v2', JSON.stringify(savedData));
}

async function loadLayout() {
    const saved = localStorage.getItem('dashboard_layout_v2') || localStorage.getItem('dashboard_layout');
    if (saved) {
        const layout = JSON.parse(saved);
        for (const item of layout) {
            await createChart(item.identifier, item.title, item.timeframe, { x: item.x, y: item.y, w: item.w || 4, h: item.h || 2 });
        }
        if (layout.length > 0) {
            addMessage(`已自動為您還原上次的 ${layout.length} 個圖表。`, 'system');
        }
    }
    updateEmptyState();
}

async function populateSensors() {
    try {
        const res = await fetch('/api/sensors');
        const sensors = await res.json();
        const select = document.getElementById('sensorSelect');
        select.innerHTML = '<option value="">-- 請選擇想加入的感測器 --</option>';
        
        sensors.forEach(sensor => {
            const option = document.createElement('option');
            option.value = sensor.identifier;
            option.textContent = sensor.title;
            select.appendChild(option);
        });
    } catch (e) {
        console.error("Failed to load sensors", e);
    }
}

document.getElementById('manualAddBtn').addEventListener('click', async () => {
    const select = document.getElementById('sensorSelect');
    const identifier = select.value;
    const title = select.options[select.selectedIndex].text;
    
    if (!identifier) {
        addMessage("請先從下拉選單選擇一個感測器！", 'system');
        return;
    }
    
    if (activeCharts[identifier]) {
        addMessage(`圖表「${title}」已經在您的儀表板上了。`, 'system');
        return;
    }
    
    addMessage(`手動加入：${title}`, 'user');
    await createChart(identifier, title, 15);
});

// Load layout and sensors on startup
loadLayout();
populateSensors();

// Refresh sensors list periodically just in case new hardware is detected
setInterval(populateSensors, 30000);

document.getElementById('timeframeSelect').addEventListener('change', (e) => {
    const mins = parseInt(e.target.value);
    for (const chart of Object.values(activeCharts)) {
        chart.config.options.plugins.timeframe = mins;
        // The x-axis min will automatically update on next tick
        chart.update('none');
    }
    saveLayout();
    addMessage(`已將所有圖表顯示範圍切換為 ${mins} 分鐘。`, 'system');
});

sendBtn.addEventListener('click', handleCommand);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleCommand();
});

// --- Chart Color Engine ---
function getChartColors(ctx, value, identifier) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    let color = { r: 102, g: 252, b: 241, hex: '#66fcf1' }; // Cyan (Safe)
    
    // Dynamic thresholds based on sensor type
    let warningThreshold = 75;
    let dangerThreshold = 85;
    
    if (identifier.includes('load')) {
        warningThreshold = 80;
        dangerThreshold = 95;
    }
    
    if (value >= dangerThreshold) {
        color = { r: 255, g: 75, b: 75, hex: '#ff4b4b' }; // Red (Danger)
    } else if (value >= warningThreshold) {
        color = { r: 255, g: 180, b: 50, hex: '#ffb432' }; // Orange (Warning)
    }
    
    gradient.addColorStop(0, `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`);
    gradient.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, 0.0)`);
    
    return { gradient, borderColor: color.hex };
}

// UX Functions
let thinkingEl = null;
function showThinking() {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'typing-indicator';
    thinkingEl.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    chatHistory.appendChild(thinkingEl);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}
function removeThinking() {
    if (thinkingEl && thinkingEl.parentNode) {
        thinkingEl.parentNode.removeChild(thinkingEl);
        thinkingEl = null;
    }
}

function updateEmptyState() {
    const emptyState = document.getElementById('emptyState');
    if (emptyState) {
        emptyState.style.opacity = Object.keys(activeCharts).length === 0 ? '1' : '0';
    }
}

// Alert Modal Logic
const alertsHistory = [];
let unreadAlerts = 0;

function updateAlertBadge() {
    const badge = document.getElementById('alertBadge');
    if (unreadAlerts > 0) {
        badge.textContent = unreadAlerts > 99 ? '99+' : unreadAlerts;
        badge.style.display = 'block';
    } else {
        badge.style.display = 'none';
    }
}

function renderAlertHistory() {
    const list = document.getElementById('alertHistoryList');
    if (alertsHistory.length === 0) {
        list.innerHTML = '<div class="no-alerts">目前沒有任何警報紀錄</div>';
        return;
    }
    list.innerHTML = alertsHistory.map(alert => `
        <div class="alert-item">
            <div class="alert-time">${alert.time}</div>
            <div class="alert-msg">${alert.msg}</div>
        </div>
    `).join('');
}

document.getElementById('alertBtn')?.addEventListener('click', () => {
    document.getElementById('alertModal').classList.add('active');
    unreadAlerts = 0;
    updateAlertBadge();
});
document.getElementById('closeAlertBtn')?.addEventListener('click', () => {
    document.getElementById('alertModal').classList.remove('active');
});

