/* ============================================
   Google Agent Dashboard — Application Logic
   ============================================ */

(function () {
  'use strict';

  // --- Constants ---
  const WEBHOOK_URL = 'URL here https://muneeburrehman3.app.n8n.cloud/webhook/google-agent'; // TODO: Paste your n8n Production Webhook "URL here https://muneeburrehman3.app.n8n.cloud/webhook/google-agent"

  const STORAGE_KEYS = {
    HISTORY: 'googleAgent_history',
    SESSION_ID: 'googleAgent_sessionId',
    CURRENT_MESSAGES: 'googleAgent_currentMessages',
  };

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_FILE_SIZE_MB = 20;

  // --- State ---
  let currentSessionId = loadFromStorage(STORAGE_KEYS.SESSION_ID) || generateSessionId();
  let currentMessages = loadFromStorage(STORAGE_KEYS.CURRENT_MESSAGES) || [];
  let isWaiting = false;
  let attachedFile = null; // { file: File, base64: string, type: 'audio'|'image'|'file' }

  // Voice recording state
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingTimerInterval = null;
  let recordingStartTime = null;
  let isRecording = false;

  // --- DOM References ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const DOM = {
    sidebar: $('#sidebar'),
    sidebarOverlay: $('#sidebar-overlay'),
    mobileMenuBtn: $('#mobile-menu-btn'),
    messagesContainer: $('#messages-container'),
    welcomeScreen: $('#welcome-screen'),
    messageInput: $('#message-input'),
    sendBtn: $('#send-btn'),
    newChatBtn: $('#new-chat-btn'),
    clearChatBtn: $('#clear-chat-btn'),
    exportBtn: $('#export-btn'),
    connectionStatus: $('#connection-status'),
    statusDot: $('#status-dot'),
    statusText: $('#status-text'),
    historyList: $('#history-list'),
    historySearchInput: $('#history-search-input'),
    chatTitle: $('#chat-title'),
    chatSubtitle: $('#chat-subtitle'),
    toastContainer: $('#toast-container'),
    sidebarTabs: $$('.sidebar-tab'),
    sidebarPanels: $$('.sidebar-panel'),
    quickActionBtns: $$('.quick-action-btn'),
    suggestionCards: $$('.suggestion-card'),
    // File upload
    fileInput: $('#file-input'),
    attachBtn: $('#attach-btn'),
    filePreview: $('#file-preview'),
    filePreviewCard: $('#file-preview-card'),
    filePreviewIcon: $('#file-preview-icon'),
    filePreviewName: $('#file-preview-name'),
    filePreviewMeta: $('#file-preview-meta'),
    filePreviewImage: $('#file-preview-image'),
    fileRemoveBtn: $('#file-remove-btn'),
    // Voice recording
    micBtn: $('#mic-btn'),
    recordingOverlay: $('#recording-overlay'),
    recordingTimer: $('#recording-timer'),
    recordingStopBtn: $('#recording-stop-btn'),
    recordingCancelBtn: $('#recording-cancel-btn'),
  };

  // ============================================
  //  Initialization
  // ============================================
  function init() {
    saveToStorage(STORAGE_KEYS.SESSION_ID, currentSessionId);

    if (currentMessages.length > 0) {
      DOM.welcomeScreen.style.display = 'none';
      currentMessages.forEach((msg) => renderMessage(msg, false));
      scrollToBottom();
    }

    pruneHistory();
    renderHistory();
    testConnection();
    bindEvents();
    autoResizeTextarea();
  }

  // ============================================
  //  Event Bindings
  // ============================================
  function bindEvents() {
    // Send message
    DOM.sendBtn.addEventListener('click', handleSend);
    DOM.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Enable/disable send button
    DOM.messageInput.addEventListener('input', () => {
      updateSendButtonState();
      autoResizeTextarea();
    });

    // Sidebar tabs
    DOM.sidebarTabs.forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Quick actions
    DOM.quickActionBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const prompt = btn.dataset.prompt;
        if (prompt) {
          DOM.messageInput.value = prompt;
          updateSendButtonState();
          DOM.messageInput.focus();
          closeSidebar();
        }
      });
    });

    // Suggestion cards
    DOM.suggestionCards.forEach((card) => {
      card.addEventListener('click', () => {
        const prompt = card.dataset.prompt;
        if (prompt) {
          DOM.messageInput.value = prompt;
          updateSendButtonState();
          handleSend();
        }
      });
    });

    // New chat
    DOM.newChatBtn.addEventListener('click', startNewChat);

    // Clear chat
    DOM.clearChatBtn.addEventListener('click', () => {
      if (currentMessages.length === 0) return;
      startNewChat();
      showToast('Chat cleared', 'info');
    });

    // Export
    DOM.exportBtn.addEventListener('click', exportConversation);

    // Connection testing
    DOM.connectionStatus.addEventListener('click', testConnection);

    // History search
    DOM.historySearchInput.addEventListener('input', () => {
      renderHistory(DOM.historySearchInput.value);
    });

    // Mobile menu
    DOM.mobileMenuBtn.addEventListener('click', toggleSidebar);
    DOM.sidebarOverlay.addEventListener('click', closeSidebar);

    // File upload
    DOM.attachBtn.addEventListener('click', () => DOM.fileInput.click());
    DOM.fileInput.addEventListener('change', handleFileSelect);
    DOM.fileRemoveBtn.addEventListener('click', removeAttachedFile);

    // Voice recording
    DOM.micBtn.addEventListener('click', toggleRecording);
    DOM.recordingStopBtn.addEventListener('click', stopRecording);
    DOM.recordingCancelBtn.addEventListener('click', cancelRecording);
  }

  // ============================================
  //  File Upload Handling
  // ============================================
  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Check file size
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      showToast(`File too large (max ${MAX_FILE_SIZE_MB}MB)`, 'error');
      DOM.fileInput.value = '';
      return;
    }

    // Determine type
    let fileType = 'file';
    if (file.type.startsWith('audio/')) fileType = 'audio';
    else if (file.type.startsWith('image/')) fileType = 'image';

    // Convert to base64
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1]; // Remove data:...;base64, prefix
      attachedFile = {
        file: file,
        base64: base64,
        type: fileType,
        mimeType: file.type,
        fileName: file.name,
      };
      showFilePreview();
      updateSendButtonState();
    };
    reader.onerror = () => {
      showToast('Failed to read file', 'error');
    };
    reader.readAsDataURL(file);
  }

  function showFilePreview() {
    if (!attachedFile) return;

    const icons = { audio: '🎵', image: '🖼️', file: '📄' };
    DOM.filePreviewIcon.textContent = icons[attachedFile.type] || '📎';
    DOM.filePreviewName.textContent = attachedFile.fileName;
    DOM.filePreviewMeta.textContent = `${attachedFile.mimeType} · ${formatFileSize(attachedFile.file.size)}`;
    DOM.filePreview.style.display = 'block';
    DOM.attachBtn.classList.add('has-file');

    // Show image thumbnail
    if (attachedFile.type === 'image') {
      DOM.filePreviewImage.src = URL.createObjectURL(attachedFile.file);
      DOM.filePreviewImage.style.display = 'block';
    } else {
      DOM.filePreviewImage.style.display = 'none';
    }
  }

  function removeAttachedFile() {
    if (attachedFile && attachedFile.type === 'image' && DOM.filePreviewImage.src) {
      URL.revokeObjectURL(DOM.filePreviewImage.src);
    }
    attachedFile = null;
    DOM.fileInput.value = '';
    DOM.filePreview.style.display = 'none';
    DOM.filePreviewImage.style.display = 'none';
    DOM.attachBtn.classList.remove('has-file');
    updateSendButtonState();
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function updateSendButtonState() {
    const hasText = DOM.messageInput.value.trim().length > 0;
    const hasFile = attachedFile !== null;
    DOM.sendBtn.disabled = !hasText && !hasFile;
  }

  // ============================================
  //  Voice Recording (MediaRecorder API)
  // ============================================
  function toggleRecording() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Determine best supported mime type
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : 'audio/wav';

      mediaRecorder = new MediaRecorder(stream, { mimeType });
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        // Stop all tracks to release mic
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(250); // Collect data every 250ms
      isRecording = true;
      recordingStartTime = Date.now();

      // Update UI
      DOM.micBtn.classList.add('recording');
      DOM.recordingOverlay.style.display = 'flex';
      DOM.recordingTimer.textContent = '0:00';

      // Start timer
      recordingTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        DOM.recordingTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      }, 500);

      showToast('🎙️ Recording started...', 'info');

    } catch (err) {
      console.error('Microphone access error:', err);
      if (err.name === 'NotAllowedError') {
        showToast('Microphone access denied. Please allow microphone permission.', 'error');
      } else if (err.name === 'NotFoundError') {
        showToast('No microphone found on this device.', 'error');
      } else {
        showToast('Could not access microphone: ' + err.message, 'error');
      }
    }
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

    // Use the onstop event to process the recording after all data is collected
    const originalOnStop = mediaRecorder.onstop;
    mediaRecorder.onstop = (e) => {
      if (originalOnStop) originalOnStop(e);
      processRecording();
    };

    mediaRecorder.stop();
    cleanupRecordingUI();
  }

  function cancelRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

    mediaRecorder.stop();
    audioChunks = []; // Discard data
    cleanupRecordingUI();
    showToast('Recording cancelled', 'info');
  }

  function cleanupRecordingUI() {
    isRecording = false;
    DOM.micBtn.classList.remove('recording');
    DOM.recordingOverlay.style.display = 'none';
    if (recordingTimerInterval) {
      clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;
    }
  }

  function processRecording() {
    if (audioChunks.length === 0) return;

    const mimeType = mediaRecorder.mimeType || 'audio/webm';
    const audioBlob = new Blob(audioChunks, { type: mimeType });
    audioChunks = [];

    // Convert to base64
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('wav') ? 'wav' : 'webm';
      const fileName = `voice_${Date.now()}.${ext}`;

      // Set as attached file and auto-send
      attachedFile = {
        file: new File([audioBlob], fileName, { type: mimeType }),
        base64: base64,
        type: 'audio',
        mimeType: mimeType,
        fileName: fileName,
      };

      // Calculate duration for display
      const duration = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0;
      const durationStr = `${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')}`;

      showToast(`🎤 Voice recorded (${durationStr})`, 'success');

      // Auto-send the voice message
      updateSendButtonState();
      handleSend();
    };
    reader.readAsDataURL(audioBlob);
  }

  // ============================================
  //  Core: Send & Receive Messages
  // ============================================
  async function handleSend() {
    const text = DOM.messageInput.value.trim();
    const file = attachedFile;

    if (!text && !file) return;
    if (isWaiting) return;

    if (!WEBHOOK_URL || WEBHOOK_URL.includes('YOUR_WEBHOOK_URL')) {
      showToast('Please set your n8n Webhook URL in app.js first!', 'error');
      return;
    }

    // Determine message type and display text
    let displayText = text;
    let type = 'text';
    let payload = {
      message: text,
      type: 'text',
      sessionId: currentSessionId,
    };

    if (file) {
      type = file.type;
      payload = {
        message: text || `[${file.type === 'audio' ? 'Voice message' : file.type === 'image' ? 'Image' : 'File'}: ${file.fileName}]`,
        type: file.type,
        sessionId: currentSessionId,
        fileData: file.base64,
        fileName: file.fileName,
        mimeType: file.mimeType,
      };

      if (!text) {
        const labels = { audio: '🎵 Voice message', image: '🖼️ Image', file: '📄 File' };
        displayText = `${labels[file.type]}: ${file.fileName}`;
      } else {
        const labels = { audio: '🎵', image: '🖼️', file: '📄' };
        displayText = `${text}\n\n${labels[file.type]} ${file.fileName}`;
      }
    }

    // Add user message to UI
    const userMsg = createMessage('user', displayText);
    if (file) {
      userMsg.attachment = { type: file.type, name: file.fileName, mimeType: file.mimeType };
    }
    addMessage(userMsg);

    // Clear input
    DOM.messageInput.value = '';
    removeAttachedFile();
    updateSendButtonState();
    autoResizeTextarea();

    // Show typing indicator
    isWaiting = true;
    showTypingIndicator();

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const aiText = data.response || data.output || JSON.stringify(data);

      const aiMsg = createMessage('assistant', aiText);
      addMessage(aiMsg);
      setConnectionStatus(true);

    } catch (err) {
      console.error('Webhook error:', err);
      const errorMsg = createMessage('assistant',
        `⚠️ **Error communicating with n8n:**\n\n${err.message}\n\nPlease check your webhook URL in Settings and make sure your n8n workflow is active.`
      );
      addMessage(errorMsg);
      setConnectionStatus(false);
    } finally {
      isWaiting = false;
      hideTypingIndicator();
    }
  }

  // ============================================
  //  Message Management
  // ============================================
  function createMessage(role, content) {
    return {
      id: generateId(),
      role,
      content,
      timestamp: new Date().toISOString(),
      sessionId: currentSessionId,
    };
  }

  function addMessage(msg) {
    currentMessages.push(msg);
    saveToStorage(STORAGE_KEYS.CURRENT_MESSAGES, currentMessages);
    addToHistory(msg);
    renderMessage(msg, true);

    if (DOM.welcomeScreen && DOM.welcomeScreen.style.display !== 'none') {
      DOM.welcomeScreen.style.display = 'none';
    }

    if (currentMessages.length === 1 && msg.role === 'user') {
      const title = msg.content.length > 40 ? msg.content.substring(0, 40) + '...' : msg.content;
      DOM.chatTitle.textContent = title;
    }

    scrollToBottom();
  }

  function renderMessage(msg, animate) {
    const div = document.createElement('div');
    div.className = `message ${msg.role}`;
    if (!animate) div.style.animation = 'none';

    const avatar = msg.role === 'user' ? '👤' : '🤖';
    const time = formatTime(new Date(msg.timestamp));

    let attachmentHtml = '';
    if (msg.attachment) {
      const icons = { audio: '🎵', image: '🖼️', file: '📄' };
      attachmentHtml = `
        <div class="message-attachment">
          <span class="att-icon">${icons[msg.attachment.type] || '📎'}</span>
          <span class="att-name">${escapeHtml(msg.attachment.name)}</span>
        </div>`;
    }

    div.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div>
        <div class="message-bubble">${formatContent(msg.content)}${attachmentHtml}</div>
        <span class="message-time">${time}</span>
      </div>
    `;

    const typingEl = DOM.messagesContainer.querySelector('.typing-indicator');
    if (typingEl) {
      DOM.messagesContainer.insertBefore(div, typingEl);
    } else {
      DOM.messagesContainer.appendChild(div);
    }
  }

  function formatContent(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/`(.*?)`/g, '<code style="background:rgba(168,85,247,0.15);padding:2px 6px;border-radius:4px;font-size:12px;">$1</code>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  //  Typing Indicator
  // ============================================
  function showTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'typing-indicator';
    div.id = 'typing-indicator';
    div.innerHTML = `
      <div class="message-avatar">🤖</div>
      <div class="typing-dots"><span></span><span></span><span></span></div>
    `;
    DOM.messagesContainer.appendChild(div);
    scrollToBottom();
  }

  function hideTypingIndicator() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  // ============================================
  //  History (localStorage, 7-day retention)
  // ============================================
  function getHistory() {
    return loadFromStorage(STORAGE_KEYS.HISTORY) || [];
  }

  function addToHistory(msg) {
    const history = getHistory();
    history.push(msg);
    saveToStorage(STORAGE_KEYS.HISTORY, history);
    renderHistory(DOM.historySearchInput.value);
  }

  function pruneHistory() {
    const history = getHistory();
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    const pruned = history.filter((msg) => new Date(msg.timestamp).getTime() > cutoff);
    if (pruned.length !== history.length) {
      saveToStorage(STORAGE_KEYS.HISTORY, pruned);
    }
  }

  function clearHistory() {
    saveToStorage(STORAGE_KEYS.HISTORY, []);
    renderHistory();
    showToast('History cleared', 'info');
  }

  function renderHistory(searchQuery = '') {
    const history = getHistory();
    const container = DOM.historyList;
    container.innerHTML = '';

    if (history.length === 0) {
      container.innerHTML = `
        <div class="history-empty">
          <div class="empty-icon">📭</div>
          <p>No conversation history yet</p>
          <p style="margin-top:4px;font-size:11px;">Start chatting to see your history here</p>
        </div>`;
      return;
    }

    let userMessages = history.filter((msg) => msg.role === 'user');
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      userMessages = userMessages.filter((msg) => msg.content.toLowerCase().includes(q));
    }

    if (userMessages.length === 0) {
      container.innerHTML = `
        <div class="history-empty">
          <div class="empty-icon">🔍</div>
          <p>No matching conversations</p>
        </div>`;
      return;
    }

    const groups = {};
    userMessages.reverse().forEach((msg) => {
      const label = getRelativeDateLabel(new Date(msg.timestamp));
      if (!groups[label]) groups[label] = [];
      groups[label].push(msg);
    });

    Object.entries(groups).forEach(([label, messages]) => {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'history-date-group';

      const labelEl = document.createElement('div');
      labelEl.className = 'history-date-label';
      labelEl.textContent = label;
      groupDiv.appendChild(labelEl);

      messages.forEach((msg) => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
          <span class="history-icon">💬</span>
          <div class="history-content">
            <div class="history-msg">${escapeHtml(msg.content)}</div>
            <div class="history-time">${formatTime(new Date(msg.timestamp))}</div>
          </div>`;
        item.addEventListener('click', () => {
          DOM.messageInput.value = msg.content;
          updateSendButtonState();
          DOM.messageInput.focus();
          closeSidebar();
        });
        groupDiv.appendChild(item);
      });

      container.appendChild(groupDiv);
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'history-clear-btn';
    clearBtn.textContent = '🗑️ Clear All History';
    clearBtn.addEventListener('click', clearHistory);
    container.appendChild(clearBtn);
  }

  function getRelativeDateLabel(date) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor((today - msgDate) / (24 * 60 * 60 * 1000));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ============================================
  //  Session Management
  // ============================================
  function startNewChat() {
    currentMessages = [];
    currentSessionId = generateSessionId();
    saveToStorage(STORAGE_KEYS.SESSION_ID, currentSessionId);
    saveToStorage(STORAGE_KEYS.CURRENT_MESSAGES, currentMessages);

    DOM.messagesContainer.innerHTML = '';
    DOM.messagesContainer.appendChild(createWelcomeScreen());
    DOM.chatTitle.textContent = 'New Conversation';

    DOM.messageInput.value = '';
    removeAttachedFile();
    updateSendButtonState();
    closeSidebar();
  }

  function createWelcomeScreen() {
    const div = document.createElement('div');
    div.className = 'welcome-screen';
    div.id = 'welcome-screen';
    div.innerHTML = `
      <div class="welcome-icon">🤖</div>
      <h2 class="welcome-title">Google Agent Dashboard</h2>
      <p class="welcome-subtitle">
        Your AI workspace assistant powered by Groq.
        Manage emails, schedule events, dictate with voice, and upload files — all from one place.
      </p>
      <div class="welcome-suggestions">
        <div class="suggestion-card" data-prompt="Show me my latest emails">
          <div class="suggestion-icon">📧</div>
          <div class="suggestion-text">Check my recent emails</div>
        </div>
        <div class="suggestion-card" data-prompt="What's on my calendar today?">
          <div class="suggestion-icon">📅</div>
          <div class="suggestion-text">What's on my schedule today?</div>
        </div>
        <div class="suggestion-card" data-prompt="Send an email to my team about the project update">
          <div class="suggestion-icon">✉️</div>
          <div class="suggestion-text">Compose a team update email</div>
        </div>
        <div class="suggestion-card" data-prompt="Schedule a meeting for tomorrow at 3pm">
          <div class="suggestion-icon">📆</div>
          <div class="suggestion-text">Schedule a meeting</div>
        </div>
      </div>`;

    setTimeout(() => {
      div.querySelectorAll('.suggestion-card').forEach((card) => {
        card.addEventListener('click', () => {
          const prompt = card.dataset.prompt;
          if (prompt) {
            DOM.messageInput.value = prompt;
            updateSendButtonState();
            handleSend();
          }
        });
      });
    }, 0);

    return div;
  }

  // ============================================
  //  Settings & Connection
  // ============================================

  async function testConnection() {
    if (!WEBHOOK_URL || WEBHOOK_URL.includes('YOUR_WEBHOOK_URL')) {
      setConnectionStatus(false, 'No URL set');
      return;
    }

    setConnectionStatus(null, 'Testing...');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'ping', type: 'text', sessionId: 'connection-test' }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      setConnectionStatus(true);
    } catch (err) {
      setConnectionStatus(false, 'Unreachable');
    }
  }

  function setConnectionStatus(connected, label) {
    if (connected === null) {
      DOM.statusDot.className = 'status-dot';
      DOM.statusDot.style.background = 'var(--accent-orange)';
      DOM.statusText.textContent = label || 'Testing...';
    } else if (connected) {
      DOM.statusDot.className = 'status-dot connected';
      DOM.statusDot.style.background = '';
      DOM.statusText.textContent = 'Connected';
    } else {
      DOM.statusDot.className = 'status-dot';
      DOM.statusDot.style.background = '';
      DOM.statusText.textContent = label || 'Not connected';
    }
  }

  // ============================================
  //  Export
  // ============================================
  function exportConversation() {
    if (currentMessages.length === 0) {
      showToast('Nothing to export', 'info');
      return;
    }

    let text = `Google Agent Conversation — ${new Date().toLocaleString()}\n${'='.repeat(50)}\n\n`;
    currentMessages.forEach((msg) => {
      const role = msg.role === 'user' ? '👤 You' : '🤖 Agent';
      const time = new Date(msg.timestamp).toLocaleTimeString();
      text += `[${time}] ${role}:\n${msg.content}\n\n`;
    });

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `google-agent-chat-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Conversation exported!', 'success');
  }

  // ============================================
  //  UI Helpers
  // ============================================
  function switchTab(tabName) {
    DOM.sidebarTabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tabName));
    DOM.sidebarPanels.forEach((p) => p.classList.toggle('active', p.id === `panel-${tabName}`));
  }

  function toggleSidebar() {
    DOM.sidebar.classList.toggle('open');
    DOM.sidebarOverlay.classList.toggle('active');
  }

  function closeSidebar() {
    DOM.sidebar.classList.remove('open');
    DOM.sidebarOverlay.classList.remove('active');
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;
    });
  }

  function autoResizeTextarea() {
    const el = DOM.messageInput;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
    toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    DOM.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'toastSlideOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function formatTime(date) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  // ============================================
  //  Storage Helpers
  // ============================================
  function saveToStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { console.warn('localStorage save failed:', e); }
  }

  function loadFromStorage(key) {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch (e) { return null; }
  }

  function generateSessionId() {
    return 'session-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
  }

  function generateId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 10);
  }

  // ============================================
  //  Boot
  // ============================================
  document.addEventListener('DOMContentLoaded', init);
})();
