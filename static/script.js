const chatHistory = document.getElementById('chatHistory');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const dashboard = document.getElementById('dashboard');

const activeCharts = {}; // { identifier: chartInstance }

// WebSocket connection
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
let ws;

function connectWebSocket() {
    ws = new WebSocket(wsUrl);
    
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'update') {
            const dataMap = msg.data;
            // Update all active charts
            for (const [identifier, chart] of Object.entries(activeCharts)) {
                if (dataMap[identifier]) {
                    const point = {
                        x: dataMap[identifier].timestamp,
                        y: dataMap[identifier].value
                    };
                    
                    const dataset = chart.data.datasets[0];
                    dataset.data.push(point);
                    
                    // Maintain a sliding window (e.g., last 15 minutes)
                    const timeframeMs = (chart.config.options.plugins.timeframe || 15) * 60 * 1000;
                    const cutoff = point.x - timeframeMs;
                    
                    while (dataset.data.length > 0 && dataset.data[0].x < cutoff) {
                        dataset.data.shift();
                    }
                    
                    chart.update('none');
                }
            }
        } else if (msg.type === 'alert') {
            addMessage(msg.message, 'system');
            // Flash red border effect
            dashboard.style.boxShadow = 'inset 0 0 50px rgba(255, 76, 76, 0.5)';
            setTimeout(() => dashboard.style.boxShadow = 'none', 1500);
        }
    };

    ws.onclose = () => {
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
    
    addMessage('AI Agent 正在分析指令...', 'system');
    
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });
        
        const result = await response.json();
        
        // Remove the 'thinking' message
        chatHistory.lastChild.remove();
        
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
        if(chatHistory.lastChild.textContent.includes('分析指令')) {
            chatHistory.lastChild.remove();
        }
        addMessage(`連線發生錯誤: ${err.message}`, 'system');
    }
}

async function createChart(identifier, title, timeframe) {
    // Fetch historical data to prepopulate chart
    const res = await fetch(`/api/history?identifier=${encodeURIComponent(identifier)}&minutes=${timeframe}`);
    const { data } = await res.json();
    
    const formattedData = data.map(d => ({ x: d.timestamp, y: d.value }));

    // Create DOM structure
    const container = document.createElement('div');
    container.className = 'chart-container glass-panel';
    container.id = `chart-container-${identifier}`;

    const header = document.createElement('div');
    header.className = 'chart-header';
    
    const titleEl = document.createElement('div');
    titleEl.className = 'chart-title';
    titleEl.textContent = title.toUpperCase().replace('_', ' ');
    
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.innerHTML = '×';
    removeBtn.title = '移除圖表';
    removeBtn.onclick = () => removeChart(identifier);

    header.appendChild(titleEl);
    header.appendChild(removeBtn);

    const canvas = document.createElement('canvas');
    container.appendChild(header);
    container.appendChild(canvas);
    
    dashboard.appendChild(container);

    // Initialize Chart.js
    const ctx = canvas.getContext('2d');
    
    // Create subtle gradient fill
    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, 'rgba(102, 252, 241, 0.4)');
    gradient.addColorStop(1, 'rgba(102, 252, 241, 0.0)');

    const chart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: title,
                data: formattedData,
                borderColor: '#66fcf1',
                backgroundColor: gradient,
                borderWidth: 2,
                pointRadius: 0,
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
}

function removeChart(identifier) {
    if (activeCharts[identifier]) {
        activeCharts[identifier].destroy();
        delete activeCharts[identifier];
        const container = document.getElementById(`chart-container-${identifier}`);
        if (container) {
            container.style.animation = 'zoomOut 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards';
            setTimeout(() => container.remove(), 300);
        }
        saveLayout();
    }
}

function saveLayout() {
    const layout = Object.keys(activeCharts).map(id => ({
        identifier: id,
        title: activeCharts[id].data.datasets[0].label,
        timeframe: activeCharts[id].config.options.plugins.timeframe || 15
    }));
    localStorage.setItem('dashboard_layout', JSON.stringify(layout));
}

async function loadLayout() {
    const saved = localStorage.getItem('dashboard_layout');
    if (saved) {
        const layout = JSON.parse(saved);
        for (const item of layout) {
            await createChart(item.identifier, item.title, item.timeframe);
        }
        if (layout.length > 0) {
            addMessage(`已自動為您還原上次的 ${layout.length} 個圖表。`, 'system');
        }
    }
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
