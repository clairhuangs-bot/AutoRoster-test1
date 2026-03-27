/**
 * AutoRoster — 客服團隊自動排班系統
 * 核心排班演算法 + UI 互動邏輯
 */

// =============================================
// 1. STATE — 全域資料狀態
// =============================================
const STATE = {
  year: 2026,
  month: 4, // 1-based
  team: [
    { id: 'leader',  name: '班長',   role: 'leader',  speed: null,   employeeId: '', leaveDays: [] },
    { id: 'deputy',  name: '副班長', role: 'deputy',  speed: 'fast', employeeId: '', leaveDays: [] },
    { id: 'memberA', name: '組員A',  role: 'member',  speed: 'fast', employeeId: '', leaveDays: [] },
    { id: 'memberB', name: '組員B',  role: 'member',  speed: 'fast', employeeId: '', leaveDays: [] },
    { id: 'memberC', name: '組員C',  role: 'member',  speed: 'slow', employeeId: '', leaveDays: [] },
    { id: 'memberD', name: '組員D',  role: 'member',  speed: 'slow', employeeId: '', leaveDays: [] },
  ],
  summer: { enabled: false, memberId: null, startDay: 1 },
  schedule: null, // filled after scheduling
  monthlyData: new Map(), // key: 'YYYY-M', value: { leaveDays, summer, schedule }
  currentView: 'calendar', // 'calendar' | 'table'
};

/** 儲存當月資料到 Map */
function saveCurrentMonth() {
  const key = `${STATE.year}-${STATE.month}`;
  STATE.monthlyData.set(key, {
    leaveDays: STATE.team.map(m => ({ id: m.id, days: [...m.leaveDays] })),
    summer: { ...STATE.summer },
    schedule: STATE.schedule,
  });
}

/** 從 Map 還原指定月份資料 */
function restoreMonth() {
  const key = `${STATE.year}-${STATE.month}`;
  const saved = STATE.monthlyData.get(key);
  if (saved) {
    // 還原每人的休假日
    saved.leaveDays.forEach(s => {
      const member = getMember(s.id);
      if (member) member.leaveDays = [...s.days];
    });
    // 還原小暑假
    STATE.summer = { ...saved.summer };
    STATE.schedule = saved.schedule;
  } else {
    // 無舊資料 → 全部清空
    STATE.team.forEach(m => m.leaveDays = []);
    STATE.summer = { enabled: false, memberId: null, startDay: 1 };
    STATE.schedule = null;
  }
}

// =============================================
// 2. UTILITIES
// =============================================
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function getFirstDayOfWeek(year, month) {
  return new Date(year, month - 1, 1).getDay(); // 0=Sun
}

function getMember(id) {
  return STATE.team.find(m => m.id === id);
}

function getLeader() { return getMember('leader'); }
function getDeputy() { return getMember('deputy'); }

/**
 * 取得前月最後 N 天的休假資料
 * @returns {Array} [{day, off: [memberIds]}] 或 []
 */
function getPrevMonthTail(n = 5) {
  let prevYear = STATE.year;
  let prevMonth = STATE.month - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  const key = `${prevYear}-${prevMonth}`;
  const saved = STATE.monthlyData.get(key);
  if (!saved || !saved.schedule) return [];
  const sch = saved.schedule;
  return sch.slice(-n).map(d => ({
    day: d.day,
    off: [...d.off],
    year: prevYear,
    month: prevMonth,
  }));
}

// =============================================
// 3. SCHEDULER — 核心排班演算法
// =============================================
const Scheduler = {
  /**
   * 執行完整排班流程 (對應 SKILL.md 的 7 個步驟)
   */
  run() {
    const totalDays = getDaysInMonth(STATE.year, STATE.month);
    const schedule = [];

    // Step 1: 初始化每日資料
    for (let day = 1; day <= totalDays; day++) {
      schedule.push({
        day,
        dutyOfficer: null,
        working: [],   // member IDs
        off: [],       // member IDs
        headcount: 0,
        powerLevel: null,   // 'green' | 'yellow' | 'red'
        powerLabel: '',
        alerts: [],    // string[]
      });
    }

    // Step 2: 鎖定硬限制 — 排入休假
    this.lockLeaves(schedule);

    // Step 2.5: 自動調整 — 移除「非使用者指定」的連休三日
    this.autoAdjustLeaves(schedule);

    // Step 3: 指派值班者 + 標示出勤
    this.assignDuty(schedule);

    // Step 4 & 5: 檢查出勤人數 + 戰力均衡
    this.validate(schedule);

    STATE.schedule = schedule;
    return schedule;
  },

  /**
   * Step 2: 鎖定所有休假（小暑假 + 必排休假日）
   */
  lockLeaves(schedule) {
    // 2a. 排入小暑假
    if (STATE.summer.enabled && STATE.summer.memberId) {
      const member = getMember(STATE.summer.memberId);
      const start = STATE.summer.startDay;
      const totalDays = schedule.length;
      for (let i = 0; i < 7; i++) {
        const day = start + i;
        if (day >= 1 && day <= totalDays) {
          if (!schedule[day - 1].off.includes(member.id)) {
            schedule[day - 1].off.push(member.id);
          }
        }
      }
    }

    // 2b. 排入必排休假日
    STATE.team.forEach(member => {
      member.leaveDays.forEach(day => {
        if (day >= 1 && day <= schedule.length) {
          if (!schedule[day - 1].off.includes(member.id)) {
            schedule[day - 1].off.push(member.id);
          }
        }
      });
    });

    // 2c. 將帥防撞檢查
    schedule.forEach(dayData => {
      const leaderOff = dayData.off.includes('leader');
      const deputyOff = dayData.off.includes('deputy');
      if (leaderOff && deputyOff) {
        dayData.alerts.push('🚨 將帥防撞衝突：班長與副班長同日休假！');
      }
    });
  },

  /**
   * Step 2.5: 自動調整 — 移除非使用者指定的連休三日
   * 使用者自行指定（必排休假日 / 小暑假）的連休不受影響
   */
  autoAdjustLeaves(schedule) {
    // 建立每人「使用者自行指定的假日」集合
    const userOff = {};
    STATE.team.forEach(m => {
      const days = new Set(m.leaveDays);
      if (STATE.summer.enabled && STATE.summer.memberId === m.id) {
        for (let i = 0; i < 7; i++) {
          const d = STATE.summer.startDay + i;
          if (d >= 1 && d <= schedule.length) days.add(d);
        }
      }
      userOff[m.id] = days;
    });

    STATE.team.forEach(member => {
      for (let i = 2; i < schedule.length; i++) {
        const d0 = schedule[i];
        const d1 = schedule[i - 1];
        const d2 = schedule[i - 2];

        const isOff0 = d0.off.includes(member.id);
        const isOff1 = d1.off.includes(member.id);
        const isOff2 = d2.off.includes(member.id);

        if (isOff0 && isOff1 && isOff2) {
          // 找出第一個「非使用者指定」的天來取消
          const candidates = [
            { dayData: d0, day: d0.day },
            { dayData: d1, day: d1.day },
            { dayData: d2, day: d2.day },
          ];
          // 優先取消最後一天（d0），若它是使用者指定的則往前找
          const toCancel = candidates.find(c => !userOff[member.id].has(c.day));
          if (toCancel) {
            toCancel.dayData.off = toCancel.dayData.off.filter(id => id !== member.id);
            const name = member.name;
            toCancel.dayData.alerts.push(`🔧 已自動取消 ${name} 第 ${toCancel.day} 日休假（避免連休≥3天）`);
          }
        }
      }
    });
  },

  /**
   * Step 3: 指派每日值班者並建立出勤名單
   */
  assignDuty(schedule) {
    schedule.forEach(dayData => {
      // 建立出勤名單（未在 off 裡的人）
      dayData.working = STATE.team
        .filter(m => !dayData.off.includes(m.id))
        .map(m => m.id);

      // 指派值班者
      if (dayData.working.includes('leader')) {
        dayData.dutyOfficer = 'leader';
      } else if (dayData.working.includes('deputy')) {
        dayData.dutyOfficer = 'deputy';
      } else {
        dayData.dutyOfficer = null;
        dayData.alerts.push('🚨 無高階管理者可值班！');
      }

      dayData.headcount = dayData.working.length;
    });
  },

  /**
   * Step 4 & 5: 驗證出勤人數 + 戰力均衡
   */
  validate(schedule) {
    // 取得前月尾巴資料（用於跨月檢查）
    const prevTail = getPrevMonthTail(5);

    // 建立每人的「人員自己指定的休假日」集合（必排休假 + 小暑假）
    const userSpecifiedOff = {};
    STATE.team.forEach(m => {
      const days = new Set(m.leaveDays);
      if (STATE.summer.enabled && STATE.summer.memberId === m.id) {
        for (let i = 0; i < 7; i++) {
          const d = STATE.summer.startDay + i;
          if (d >= 1 && d <= schedule.length) days.add(d);
        }
      }
      userSpecifiedOff[m.id] = days;
    });

    schedule.forEach(dayData => {
      const date = new Date(STATE.year, STATE.month - 1, dayData.day);
      const dow = date.getDay();
      const isBusyDay = dow === 3 || dow === 4;

      // Step 4: 出勤人數檢查
      if (isBusyDay && dayData.headcount < 5) {
        dayData.alerts.push(`⚠️ 忙碌日缺人：週三/四僅容許1人休假 (目前 ${dayData.headcount} 人)`);
      } else if (!isBusyDay && dayData.headcount < 4) {
        dayData.alerts.push(`⚠️ 缺人警示：僅 ${dayData.headcount} 人出勤`);
      }

      // Step 5: 戰力均衡
      const crewIds = dayData.working.filter(id => id !== dayData.dutyOfficer);
      const crew = crewIds.map(id => getMember(id));

      let fastCount = 0;
      let slowCount = 0;
      crew.forEach(m => {
        if (m.role === 'deputy' || m.speed === 'fast') {
          fastCount++;
        } else if (m.speed === 'slow') {
          slowCount++;
        }
      });

      if (crew.length === 0) {
        dayData.powerLevel = 'red';
        dayData.powerLabel = '無組員';
      } else if (crew.length <= 2) {
        if (fastCount >= 1 && slowCount >= 1) {
          dayData.powerLevel = 'green';
          dayData.powerLabel = '🟢 快+慢（最佳）';
        } else if (fastCount >= 2) {
          dayData.powerLevel = 'yellow';
          dayData.powerLabel = '🟡 快+快（可接受）';
        } else {
          dayData.powerLevel = 'red';
          dayData.powerLabel = '🔴 慢+慢（需注意）';
          if (!isBusyDay) dayData.alerts.push('🔴 戰力不足：慢+慢配置');
        }
      } else {
        if (fastCount >= 1) {
          dayData.powerLevel = 'green';
          dayData.powerLabel = `🟢 及格（快${fastCount}+慢${slowCount}）`;
        } else {
          dayData.powerLevel = 'red';
          dayData.powerLabel = '🔴 無快手（需注意）';
          if (!isBusyDay) dayData.alerts.push('🔴 戰力不足：無快手出勤');
        }
      }

      if (isBusyDay && fastCount < 1) {
         dayData.powerLevel = 'red';
         dayData.powerLabel = '🔴 忙碌日戰力不足';
         dayData.alerts.push(`🔴 忙碌日戰力不足：嚴格禁止「慢+慢」配置`);
      }

      // Step 6: 連休三日檢查（含跨月）
      dayData.off.forEach(memberId => {
        const isUserSpecified = userSpecifiedOff[memberId]?.has(dayData.day);
        if (isUserSpecified) return; // 人員自己指定的不檢查

        // 檢查前 2 天是否也休假
        let consecutiveOff = 1;
        for (let back = 1; back <= 2; back++) {
          const prevDay = dayData.day - back;
          if (prevDay >= 1) {
            // 當月內
            if (schedule[prevDay - 1].off.includes(memberId)) {
              consecutiveOff++;
            } else break;
          } else {
            // 跨月：參考前月尾巴
            const tailIdx = prevTail.length + prevDay; // prevDay is negative or 0
            if (tailIdx >= 0 && prevTail[tailIdx]?.off.includes(memberId)) {
              consecutiveOff++;
            } else break;
          }
        }

        if (consecutiveOff >= 3) {
          const name = getMember(memberId)?.name || memberId;
          dayData.alerts.push(`🟡 ${name} 跨月/連休≥ 3天（非自行指定）`);
        }
      });
    });
  },
};

// =============================================
// 4. UI — 介面渲染與互動
// =============================================
const UI = {
  init() {
    this.renderMonthDisplay();
    this.renderTeamList();
    this.renderLeaveConfig();
    this.renderSummerMemberSelect();
    this.bindEvents();
    this.renderCalendarGrid();
  },

  // --- Month Display ---
  renderMonthDisplay() {
    document.getElementById('month-display').textContent =
      `${STATE.year} 年 ${STATE.month} 月`;
  },

  // --- Team Cards ---
  renderTeamList() {
    const container = document.getElementById('team-list');
    container.innerHTML = STATE.team.map(m => {
      const avatarClass = m.role;
      const initials = m.name.slice(0, 1);
      const roleBadge = m.role === 'leader' ? '<span class="badge badge-leader">班長</span>'
                      : m.role === 'deputy' ? '<span class="badge badge-deputy">副班長</span>'
                      : '<span class="badge badge-member">組員</span>';
      const speedBadge = m.speed === 'fast' ? '<span class="badge badge-fast">⚡ 快</span>'
                       : m.speed === 'slow' ? '<span class="badge badge-slow">🐢 慢</span>'
                       : '';
      return `
        <div class="team-card" data-id="${m.id}">
          <div class="team-avatar ${avatarClass}">${initials}</div>
          <div class="team-info">
            <div class="team-name">${m.name}</div>
            <div class="team-badges">${roleBadge}${speedBadge}</div>
          </div>
        </div>
      `;
    }).join('');
  },

  // --- Leave Config ---
  renderLeaveConfig() {
    const container = document.getElementById('leave-config');
    const totalDays = getDaysInMonth(STATE.year, STATE.month);
    const firstDay = getFirstDayOfWeek(STATE.year, STATE.month); // 0=Sun

    container.innerHTML = STATE.team.map(m => {
      // 空白格（對齊星期）
      let cells = '';
      for (let i = 0; i < firstDay; i++) {
        cells += '<div class="leave-day-spacer"></div>';
      }
      // 日期按鈕
      for (let d = 1; d <= totalDays; d++) {
        const isSel = m.leaveDays.includes(d);
        let isSummer = false;
        if (STATE.summer.enabled && STATE.summer.memberId === m.id) {
          const sStart = STATE.summer.startDay;
          if (d >= sStart && d < sStart + 7 && d <= totalDays) {
            isSummer = true;
          }
        }
        const cls = isSummer ? 'leave-day-chip summer' : (isSel ? 'leave-day-chip selected' : 'leave-day-chip');
        cells += `<button class="${cls}" data-member="${m.id}" data-day="${d}" ${isSummer ? 'disabled' : ''}>${d}</button>`;
      }
      return `
        <div class="leave-member-section">
          <div class="leave-member-header">
            <span class="leave-member-name">${m.name}</span>
            <span class="leave-count">${m.leaveDays.length} 天</span>
          </div>
          <div class="leave-days-header">
            <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
          </div>
          <div class="leave-days">${cells}</div>
        </div>
      `;
    }).join('');
  },

  // --- Summer Vacation ---
  renderSummerMemberSelect() {
    const sel = document.getElementById('summer-member');
    sel.innerHTML = STATE.team.map(m =>
      `<option value="${m.id}">${m.name}</option>`
    ).join('');
  },

  updateSummerEnd() {
    const start = parseInt(document.getElementById('summer-start').value) || 1;
    const totalDays = getDaysInMonth(STATE.year, STATE.month);
    const end = Math.min(start + 6, totalDays);
    document.getElementById('summer-end').value = `第 ${start} 日 → 第 ${end} 日（共 ${end - start + 1} 天）`;
  },

  // --- Calendar ---
  renderCalendarGrid() {
    const grid = document.getElementById('calendar-grid');
    const emptyState = document.getElementById('empty-state');
    const summarySection = document.getElementById('summary-section');
    const viewToggles = document.getElementById('view-toggles');
    const calendarCont = document.getElementById('calendar-container');
    const tableCont = document.getElementById('table-view-container');

    if (!STATE.schedule) {
      grid.innerHTML = '';
      emptyState.style.display = 'flex';
      summarySection.style.display = 'none';
      viewToggles.style.display = 'none';
      calendarCont.style.display = 'block';
      tableCont.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    summarySection.style.display = 'grid';
    viewToggles.style.display = 'flex';

    if (STATE.currentView === 'table') {
      calendarCont.style.display = 'none';
      tableCont.style.display = 'block';
    } else {
      calendarCont.style.display = 'block';
      tableCont.style.display = 'none';
    }

    const totalDays = getDaysInMonth(STATE.year, STATE.month);
    const firstDay = getFirstDayOfWeek(STATE.year, STATE.month);

    let html = '';

    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      html += '<div class="calendar-cell empty"></div>';
    }

    // Day cells
    STATE.schedule.forEach(dayData => {
      const hasAlert = dayData.alerts.length > 0;
      const isShortage = dayData.headcount < 4;
      const isPowerWarn = dayData.powerLevel === 'red' && !isShortage;

      let cellClass = 'calendar-cell';
      if (isShortage) cellClass += ' warning';
      else if (isPowerWarn) cellClass += ' power-warn';

      const dutyName = dayData.dutyOfficer ? getMember(dayData.dutyOfficer).name : '—';
      const workingNames = dayData.working
        .filter(id => id !== dayData.dutyOfficer)
        .map(id => getMember(id).name)
        .join(', ');
      const offNames = dayData.off
        .map(id => getMember(id).name)
        .join(', ') || '—';

      const alertEmoji = isShortage ? '⚠️' : (dayData.powerLevel === 'red' ? '🔴' : '');

      // Tooltip content
      const tooltipAlerts = dayData.alerts.map(a => a).join('\n');

      html += `
        <div class="${cellClass}">
          <div class="cell-date">
            <span>${dayData.day}</span>
            <span class="power-badge ${dayData.powerLevel}"></span>
          </div>
          <div class="cell-duty">👑 ${dutyName}</div>
          <div class="cell-working">出勤：${workingNames || '—'}</div>
          <div class="cell-off">休假：${offNames}</div>
          ${alertEmoji ? `<div class="cell-alert">${alertEmoji}</div>` : ''}
          <div class="cell-headcount">${dayData.headcount}人</div>
          ${tooltipAlerts ? `<div class="tooltip">${tooltipAlerts}</div>` : ''}
        </div>
      `;
    });

    grid.innerHTML = html;

    // Render Table View as well
    this.renderTableGrid();

    // Render summary
    this.renderSummary();
    this.renderStatusPills();
  },

  // --- Table View ---
  renderTableGrid() {
    if (!STATE.schedule) return;
    const thead = document.getElementById('st-head');
    const tbody = document.getElementById('st-body');
    const dayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    
    // Header
    let headHtml = '<tr><th>日期</th><th>星期</th><th>值班主管</th>';
    STATE.team.forEach(m => { headHtml += `<th>${m.name}</th>`; });
    headHtml += '</tr>';
    thead.innerHTML = headHtml;
    
    let bodyHtml = '';
    
    // Prev Tail
    const prevTail = getPrevMonthTail(5);
    prevTail.forEach(dayData => {
      const date = new Date(dayData.year, dayData.month - 1, dayData.day);
      const dow = dayNames[date.getDay()];
      bodyHtml += '<tr class="row-prev">';
      bodyHtml += `<td>${dayData.month}/${dayData.day}</td><td>${dow}</td><td>—</td>`;
      STATE.team.forEach(m => {
        const isOff = dayData.off.includes(m.id);
        const cellClass = isOff ? 'cell-off-red' : '';
        bodyHtml += `<td class="${cellClass}">${isOff ? '休' : ''}</td>`;
      });
      bodyHtml += '</tr>';
    });

    // Current Month
    STATE.schedule.forEach(dayData => {
      const date = new Date(STATE.year, STATE.month - 1, dayData.day);
      const dow = dayNames[date.getDay()];
      bodyHtml += '<tr>';
      const dutyName = dayData.dutyOfficer ? getMember(dayData.dutyOfficer).name : '—';
      bodyHtml += `<td>${dayData.day}</td><td>${dow}</td><td class="cell-duty">${dutyName}</td>`;
      STATE.team.forEach(m => {
        let text = '';
        let cellClass = '';
        if (dayData.off.includes(m.id)) {
           text = '休';
           cellClass = 'cell-off-red';
        } else if (m.id === dayData.dutyOfficer) {
           text = '值';
           cellClass = 'cell-duty';
        }
        bodyHtml += `<td class="${cellClass}">${text}</td>`;
      });
      bodyHtml += '</tr>';
    });
    
    tbody.innerHTML = bodyHtml;
  },

  // --- Summary ---
  renderSummary() {
    const schedule = STATE.schedule;
    if (!schedule) return;

    // Alert summary
    const clashDays = schedule.filter(d => d.alerts.some(a => a.includes('將帥防撞'))).length;
    const shortageDays = schedule.filter(d => d.headcount < 4);
    const slowSlowDays = schedule.filter(d => d.powerLevel === 'red');

    const alertList = document.getElementById('alert-list');
    alertList.innerHTML = `
      <div class="alert-item ${clashDays === 0 ? 'ok' : 'error'}">
        <span>${clashDays === 0 ? '✅' : '🚨'}</span>
        <span>將帥防撞衝突：${clashDays} 天${clashDays > 0 ? '（' + schedule.filter(d => d.alerts.some(a => a.includes('將帥防撞'))).map(d => d.day + '日').join(', ') + '）' : ''}</span>
      </div>
      <div class="alert-item ${shortageDays.length === 0 ? 'ok' : 'error'}">
        <span>${shortageDays.length === 0 ? '✅' : '⚠️'}</span>
        <span>缺人警示：${shortageDays.length} 天${shortageDays.length > 0 ? '（' + shortageDays.map(d => d.day + '日').join(', ') + '）' : ''}</span>
      </div>
      <div class="alert-item ${slowSlowDays.length === 0 ? 'ok' : 'warn'}">
        <span>${slowSlowDays.length === 0 ? '✅' : '🔴'}</span>
        <span>戰力不足：${slowSlowDays.length} 天${slowSlowDays.length > 0 ? '（' + slowSlowDays.map(d => d.day + '日').join(', ') + '）' : ''}</span>
      </div>
    `;

    // Person stats
    const totalDays = schedule.length;
    const statsBody = document.getElementById('stats-body');
    statsBody.innerHTML = STATE.team.map(m => {
      const workDays = schedule.filter(d => d.working.includes(m.id)).length;
      const offDays = schedule.filter(d => d.off.includes(m.id)).length;
      const roleLabel = m.role === 'leader' ? '班長' : m.role === 'deputy' ? '副班長' : '組員';
      const speedLabel = m.speed === 'fast' ? '⚡ 快' : m.speed === 'slow' ? '🐢 慢' : '—';
      return `
        <tr>
          <td>${m.name}</td>
          <td>${roleLabel}</td>
          <td>${speedLabel}</td>
          <td class="num">${workDays}</td>
          <td class="num">${offDays}</td>
        </tr>
      `;
    }).join('');
  },

  // --- Status Pills ---
  renderStatusPills() {
    const schedule = STATE.schedule;
    if (!schedule) {
      document.getElementById('status-pills').innerHTML = '';
      return;
    }

    const clashDays = schedule.filter(d => d.alerts.some(a => a.includes('將帥防撞'))).length;
    const shortageDays = schedule.filter(d => d.headcount < 4).length;
    const redDays = schedule.filter(d => d.powerLevel === 'red').length;

    const pills = [];

    if (clashDays === 0) {
      pills.push('<div class="status-pill ok"><div class="dot"></div>將帥安全</div>');
    } else {
      pills.push(`<div class="status-pill error"><div class="dot"></div>將帥衝突 ${clashDays}天</div>`);
    }

    if (shortageDays === 0) {
      pills.push('<div class="status-pill ok"><div class="dot"></div>人力充足</div>');
    } else {
      pills.push(`<div class="status-pill error"><div class="dot"></div>缺人 ${shortageDays}天</div>`);
    }

    if (redDays === 0) {
      pills.push('<div class="status-pill ok"><div class="dot"></div>戰力均衡</div>');
    } else {
      pills.push(`<div class="status-pill warn"><div class="dot"></div>戰力不足 ${redDays}天</div>`);
    }

    document.getElementById('status-pills').innerHTML = pills.join('');
  },

  // --- Bind Events ---
  bindEvents() {
    // Month navigation
    document.getElementById('btn-prev-month').addEventListener('click', () => {
      saveCurrentMonth();
      STATE.month--;
      if (STATE.month < 1) { STATE.month = 12; STATE.year--; }
      this.onMonthChange();
    });

    document.getElementById('btn-next-month').addEventListener('click', () => {
      saveCurrentMonth();
      STATE.month++;
      if (STATE.month > 12) { STATE.month = 1; STATE.year++; }
      this.onMonthChange();
    });

    // Leave day chip clicks (event delegation)
    document.getElementById('leave-config').addEventListener('click', (e) => {
      const chip = e.target.closest('.leave-day-chip');
      if (!chip || chip.disabled) return;

      const memberId = chip.dataset.member;
      const day = parseInt(chip.dataset.day);
      const member = getMember(memberId);
      const isAdding = !member.leaveDays.includes(day);

      if (isAdding) {
        // ── 硬性阻擋 1：將帥防撞 ──────────────────────────
        if (memberId === 'leader' || memberId === 'deputy') {
          const otherId = memberId === 'leader' ? 'deputy' : 'leader';
          const other = getMember(otherId);
          // 對方已在 leaveDays 中包含此天
          const otherOff = other && other.leaveDays.includes(day);
          if (otherOff) {
            const otherName = other.name;
            this.showToast(`🚨 將帥防撞：${otherName} 已排休此日，不可同日休假！`, 'error');
            return;
          }
        }

        // ── 硬性阻擋 2：值班者週三不可排休 ──────────────────
        const date = new Date(STATE.year, STATE.month - 1, day);
        const isWed = date.getDay() === 3;
        if (isWed) {
          const leader = getLeader();
          const deputy = getDeputy();
          const leaderOff = leader && leader.leaveDays.includes(day);
          // 班長本人嘗試在週三排休
          if (memberId === 'leader') {
            this.showToast('🚨 班長為值班者，不可在週三排休！（硬性規定）', 'error');
            return;
          }
          // 副班長嘗試在週三排休，且班長已休
          if (memberId === 'deputy' && leaderOff) {
            this.showToast('🚨 班長已排休，副班長為本日值班者，不可在週三排休！（硬性規定）', 'error');
            return;
          }
        }

        member.leaveDays.push(day);
        member.leaveDays.sort((a, b) => a - b);
      } else {
        // Remove
        member.leaveDays = member.leaveDays.filter(d => d !== day);
      }

      // Re-render leave config
      this.renderLeaveConfig();

      // Clear schedule if exists
      if (STATE.schedule) {
        STATE.schedule = null;
        this.renderCalendarGrid();
      }
    });

    // Summer toggle
    document.getElementById('summer-toggle').addEventListener('change', (e) => {
      STATE.summer.enabled = e.target.checked;
      document.getElementById('summer-fields').classList.toggle('visible', e.target.checked);
      if (e.target.checked) {
        STATE.summer.memberId = document.getElementById('summer-member').value;
        STATE.summer.startDay = parseInt(document.getElementById('summer-start').value) || 1;
        this.updateSummerEnd();
      }
      this.renderLeaveConfig();
    });

    document.getElementById('summer-member').addEventListener('change', (e) => {
      STATE.summer.memberId = e.target.value;
      this.renderLeaveConfig();
    });

    document.getElementById('summer-start').addEventListener('input', (e) => {
      STATE.summer.startDay = parseInt(e.target.value) || 1;
      this.updateSummerEnd();
      this.renderLeaveConfig();
    });

    // Generate button
    document.getElementById('btn-generate').addEventListener('click', () => {
      this.generate();
    });

    // View Toggles
    document.getElementById('btn-view-calendar').addEventListener('click', (e) => {
      document.getElementById('btn-view-calendar').classList.add('active');
      document.getElementById('btn-view-table').classList.remove('active');
      document.getElementById('calendar-container').style.display = 'block';
      document.getElementById('table-view-container').style.display = 'none';
      STATE.currentView = 'calendar';
    });
    document.getElementById('btn-view-table').addEventListener('click', (e) => {
      document.getElementById('btn-view-table').classList.add('active');
      document.getElementById('btn-view-calendar').classList.remove('active');
      document.getElementById('calendar-container').style.display = 'none';
      document.getElementById('table-view-container').style.display = 'block';
      STATE.currentView = 'table';
    });

    // --- Copy Schedule ---
    document.getElementById('btn-copy-schedule').addEventListener('click', () => {
      this.copySchedule();
    });

    // --- Team Editor Modal ---
    document.getElementById('btn-edit-team').addEventListener('click', () => {
      TeamEditor.open();
    });
    document.getElementById('btn-editor-close').addEventListener('click', () => {
      TeamEditor.close();
    });
    document.getElementById('btn-editor-cancel').addEventListener('click', () => {
      TeamEditor.close();
    });
    document.getElementById('btn-editor-save').addEventListener('click', () => {
      TeamEditor.save();
    });
    document.getElementById('btn-add-member').addEventListener('click', () => {
      TeamEditor.addRow();
    });
    // --- Prev Tail Modal ---
    document.getElementById('btn-edit-prev-tail').addEventListener('click', () => {
      PrevTailEditor.open();
    });
    document.getElementById('btn-prev-tail-close').addEventListener('click', () => {
      PrevTailEditor.close();
    });
    document.getElementById('btn-prev-tail-cancel').addEventListener('click', () => {
      PrevTailEditor.close();
    });
    document.getElementById('btn-prev-tail-save').addEventListener('click', () => {
      PrevTailEditor.save();
    });

    // Close modal on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (document.getElementById('team-editor-modal').classList.contains('open')) {
          TeamEditor.close();
        }
        if (document.getElementById('prev-tail-modal').classList.contains('open')) {
          PrevTailEditor.close();
        }
      }
    });
  },

  // --- Month Change ---
  onMonthChange() {
    this.renderMonthDisplay();
    // 還原目標月份的資料（如有）
    restoreMonth();
    // 同步小暑假 UI
    document.getElementById('summer-toggle').checked = STATE.summer.enabled;
    document.getElementById('summer-fields').classList.toggle('visible', STATE.summer.enabled);
    if (STATE.summer.enabled) {
      document.getElementById('summer-member').value = STATE.summer.memberId || '';
      document.getElementById('summer-start').value = STATE.summer.startDay;
      this.updateSummerEnd();
    }
    this.renderLeaveConfig();
    this.renderCalendarGrid();
    this.renderStatusPills();
  },

  // --- Generate Schedule ---
  generate() {
    // Sync summer state
    if (STATE.summer.enabled) {
      STATE.summer.memberId = document.getElementById('summer-member').value;
      STATE.summer.startDay = parseInt(document.getElementById('summer-start').value) || 1;
    }

    // Run the scheduler
    Scheduler.run();

    // Render results
    this.renderCalendarGrid();

    // Animate button
    const btn = document.getElementById('btn-generate');
    btn.textContent = '✅ 排班完成！';
    btn.style.pointerEvents = 'none';
    setTimeout(() => {
      btn.innerHTML = '🚀 自動排班';
      btn.style.pointerEvents = '';
    }, 1500);

    // Scroll to calendar
    document.getElementById('calendar-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  // --- 複製班表為 HTML 表格（貼到 Excel） ---
  copySchedule() {
    if (!STATE.schedule) {
      this.showToast('⚠️ 請先執行「自動排班」再複製班表', 'warn');
      return;
    }

    const dayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const members = STATE.team;
    const schedule = STATE.schedule;
    // Excel 強制文字格式，避免自動格式化
    const txtStyle = ' style="mso-number-format:\'\\@\'"';

    let html = '<table>';

    // Row 1: Header — 日期 | 星期 | member names...
    html += '<tr>';
    html += `<td${txtStyle}>日期</td><td${txtStyle}>星期</td>`;
    members.forEach(m => { html += `<td${txtStyle}>${m.name}</td>`; });
    html += '</tr>';

    // Row 2: Sub-header — (blank) | 員工編號 | employee IDs...
    html += '<tr>';
    html += `<td${txtStyle}></td><td${txtStyle}>員工編號</td>`;
    members.forEach(m => { html += `<td${txtStyle}>${m.employeeId || ''}</td>`; });
    html += '</tr>';

    // Prev month tail rows
    const prevTail = getPrevMonthTail(5);
    prevTail.forEach(dayData => {
      const date = new Date(dayData.year, dayData.month - 1, dayData.day);
      const dow = dayNames[date.getDay()];
      html += '<tr style="color: #6b7280; background-color: #f9fafb;">';
      html += `<td${txtStyle}>${dayData.month}/${dayData.day}</td><td${txtStyle}>${dow}</td>`;
      members.forEach(m => {
        html += `<td${txtStyle}>${dayData.off.includes(m.id) ? '休' : ''}</td>`;
      });
      html += '</tr>';
    });

    // Day rows
    schedule.forEach(dayData => {
      const date = new Date(STATE.year, STATE.month - 1, dayData.day);
      const dow = dayNames[date.getDay()];
      html += '<tr>';
      html += `<td${txtStyle}>${dayData.day}</td><td${txtStyle}>${dow}</td>`;
      members.forEach(m => {
        let cellText = '班'; // 預設為上班
        if (dayData.off.includes(m.id)) {
          cellText = '休';
        } else if (m.id === dayData.dutyOfficer) {
          cellText = '值';
        }
        html += `<td${txtStyle}>${cellText}</td>`;
      });
      html += '</tr>';
    });

    html += '</table>';

    // 使用 ClipboardItem 同時提供 HTML 和純文字
    const htmlBlob = new Blob([html], { type: 'text/html' });
    const textBlob = new Blob([this._scheduleToTSV(schedule, members, dayNames)], { type: 'text/plain' });

    navigator.clipboard.write([
      new ClipboardItem({
        'text/html': htmlBlob,
        'text/plain': textBlob,
      })
    ]).then(() => {
      this.showToast('✅ 班表已複製！可直接貼到 Excel', 'ok');
    }).catch(() => {
      // Fallback: 純文字
      navigator.clipboard.writeText(this._scheduleToTSV(schedule, members, dayNames)).then(() => {
        this.showToast('✅ 班表已複製（純文字格式）', 'ok');
      }).catch(() => {
        this.showToast('❌ 複製失敗，請手動複製', 'error');
      });
    });
  },

  /** TSV fallback 格式 */
  _scheduleToTSV(schedule, members, dayNames) {
    const t = '\t';
    const lines = [];
    lines.push(['日期', '星期', ...members.map(m => m.name)].join(t));
    lines.push(['', '員工編號', ...members.map(m => m.employeeId || '')].join(t));

    const prevTail = getPrevMonthTail(5);
    prevTail.forEach(dayData => {
      const date = new Date(dayData.year, dayData.month - 1, dayData.day);
      const dow = dayNames[date.getDay()];
      const cols = [`${dayData.month}/${dayData.day}`, dow];
      members.forEach(m => {
        cols.push(dayData.off.includes(m.id) ? '休' : '');
      });
      lines.push(cols.join(t));
    });

    schedule.forEach(dayData => {
      const date = new Date(STATE.year, STATE.month - 1, dayData.day);
      const dow = dayNames[date.getDay()];
      const cols = [dayData.day, dow];
      members.forEach(m => {
        let cellText = '班';
        if (dayData.off.includes(m.id)) {
          cellText = '休';
        } else if (m.id === dayData.dutyOfficer) {
          cellText = '值';
        }
        cols.push(cellText);
      });
      lines.push(cols.join(t));
    });
    return lines.join('\n');
  },

  // --- Toast 通知 ---
  showToast(msg, type) {
    // Remove existing toast
    const old = document.querySelector('.toast');
    if (old) old.remove();

    const el = document.createElement('div');
    el.className = `toast toast-${type || 'ok'}`;
    el.textContent = msg;
    document.body.appendChild(el);

    // Trigger animation
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 2500);
  },
};

// =============================================
// 5. TEAM EDITOR — 人員編輯器邏輯
// =============================================
const TeamEditor = {
  /** 暫存編輯中的資料（deep copy） */
  _draft: [],

  /** 開啟 Modal */
  open() {
    // Deep copy current team
    this._draft = STATE.team.map(m => ({
      id: m.id,
      name: m.name,
      role: m.role,
      speed: m.speed,
      employeeId: m.employeeId || '',
    }));
    this._hideError();
    this._renderRows();
    document.getElementById('team-editor-modal').classList.add('open');
  },

  /** 關閉 Modal（不儲存） */
  close() {
    document.getElementById('team-editor-modal').classList.remove('open');
  },

  /** 新增一列空白成員 */
  addRow() {
    this._draft.push({
      id: 'member_' + Date.now(),
      name: '',
      role: 'member',
      speed: 'fast',
      employeeId: '',
    });
    this._renderRows();
    // Focus the new name input
    const inputs = document.querySelectorAll('#editor-tbody .editor-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  },

  /** 刪除指定列 */
  removeRow(idx) {
    this._draft.splice(idx, 1);
    this._renderRows();
  },

  /** 從 DOM 讀取所有欄位值回 _draft */
  _syncFromDOM() {
    const rows = document.querySelectorAll('#editor-tbody tr');
    rows.forEach((row, i) => {
      if (!this._draft[i]) return;
      this._draft[i].name       = row.querySelector('.editor-input-name').value.trim();
      this._draft[i].employeeId = row.querySelector('.editor-input-eid').value.trim();
      this._draft[i].role       = row.querySelector('.editor-select-role').value;
      this._draft[i].speed      = row.querySelector('.editor-select-speed')?.value || null;
    });
    // 班長不設效率
    this._draft.forEach(m => {
      if (m.role === 'leader') m.speed = null;
    });
  },

  /** 驗證規則，回傳錯誤訊息陣列 */
  _validate() {
    this._syncFromDOM();
    const errors = [];
    // 名稱不可空白
    const empties = this._draft.filter(m => !m.name);
    if (empties.length) errors.push('所有成員姓名不可為空白。');
    // 名稱不可重複
    const names = this._draft.map(m => m.name).filter(n => n);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) errors.push(`姓名重複：${[...new Set(dupes)].join(', ')}。`);
    // 至少 1 班長
    if (!this._draft.some(m => m.role === 'leader')) errors.push('至少需要 1 位班長。');
    // 至少 1 副班長
    if (!this._draft.some(m => m.role === 'deputy')) errors.push('至少需要 1 位副班長。');
    // 至少 4 人
    if (this._draft.length < 4) errors.push(`團隊人數至少 4 人（目前 ${this._draft.length} 人）。`);
    // 班長最多 1 人
    if (this._draft.filter(m => m.role === 'leader').length > 1) errors.push('班長最多只能 1 位。');
    // 副班長最多 1 人
    if (this._draft.filter(m => m.role === 'deputy').length > 1) errors.push('副班長最多只能 1 位。');
    return errors;
  },

  /** 儲存 */
  save() {
    const errors = this._validate();
    if (errors.length) {
      this._showError(errors.join('<br>'));
      return;
    }

    // 比對舊 team，保留既有成員的 leaveDays
    const oldMap = {};
    STATE.team.forEach(m => { oldMap[m.id] = m; });

    STATE.team = this._draft.map(m => ({
      id: m.id,
      name: m.name,
      role: m.role,
      speed: m.speed,
      employeeId: m.employeeId || '',
      leaveDays: oldMap[m.id] ? oldMap[m.id].leaveDays : [],
    }));

    // 若小暑假人員被刪除，重置
    if (STATE.summer.enabled && !getMember(STATE.summer.memberId)) {
      STATE.summer.enabled = false;
      STATE.summer.memberId = null;
      document.getElementById('summer-toggle').checked = false;
      document.getElementById('summer-fields').classList.remove('visible');
    }

    // 清除已產生的班表
    STATE.schedule = null;

    // 刷新所有 UI
    UI.renderTeamList();
    UI.renderLeaveConfig();
    UI.renderSummerMemberSelect();
    UI.renderCalendarGrid();
    document.getElementById('status-pills').innerHTML = '';

    this.close();
  },

  /** 渲染 Modal 中的成員列表 */
  _renderRows() {
    const tbody = document.getElementById('editor-tbody');
    tbody.innerHTML = this._draft.map((m, i) => {
      const isLeader = m.role === 'leader';
      return `
        <tr>
          <td class="editor-row-num">${i + 1}</td>
          <td><input class="editor-input editor-input-name" type="text" value="${this._esc(m.name)}" placeholder="姓名…"></td>
          <td><input class="editor-input editor-input-eid" type="text" value="${this._esc(m.employeeId)}" placeholder="編號…"></td>
          <td>
            <select class="editor-select editor-select-role" data-idx="${i}">
              <option value="leader" ${m.role === 'leader' ? 'selected' : ''}>班長</option>
              <option value="deputy" ${m.role === 'deputy' ? 'selected' : ''}>副班長</option>
              <option value="member" ${m.role === 'member' ? 'selected' : ''}>組員</option>
            </select>
          </td>
          <td>
            ${isLeader ? '<span style="color:var(--text-muted);font-size:0.75rem;">—</span>' : `
              <select class="editor-select editor-select-speed">
                <option value="fast" ${m.speed === 'fast' ? 'selected' : ''}>⚡ 快</option>
                <option value="slow" ${m.speed === 'slow' ? 'selected' : ''}>🐢 慢</option>
              </select>
            `}
          </td>
          <td>
            <button class="btn-delete-row" data-idx="${i}" title="刪除">🗑</button>
          </td>
        </tr>
      `;
    }).join('');

    // Bind row events (delegation)
    tbody.querySelectorAll('.btn-delete-row').forEach(btn => {
      btn.addEventListener('click', () => {
        this._syncFromDOM();
        this.removeRow(parseInt(btn.dataset.idx));
      });
    });

    // Role change → re-render (to toggle speed column)
    tbody.querySelectorAll('.editor-select-role').forEach(sel => {
      sel.addEventListener('change', () => {
        this._syncFromDOM();
        this._renderRows();
      });
    });
  },

  /** HTML escape helper */
  _esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  },

  /** 顯示錯誤 */
  _showError(html) {
    const el = document.getElementById('editor-error');
    el.innerHTML = html;
    el.classList.add('visible');
  },

  /** 隱藏錯誤 */
  _hideError() {
    const el = document.getElementById('editor-error');
    el.innerHTML = '';
    el.classList.remove('visible');
  },
};

// =============================================
// 6. PREV TAIL EDITOR — 前月尾巴編輯器邏輯
// =============================================
const PrevTailEditor = {
  _draft: [], // { day, off: Set }
  _prevYear: null,
  _prevMonth: null,
  _days: [],

  open() {
    let prevYear = STATE.year;
    let prevMonth = STATE.month - 1;
    if (prevMonth < 1) { prevMonth = 12; prevYear--; }
    this._prevYear = prevYear;
    this._prevMonth = prevMonth;
    
    const totalDays = getDaysInMonth(prevYear, prevMonth);
    const n = Math.min(5, totalDays);
    this._days = [];
    for (let i = totalDays - n + 1; i <= totalDays; i++) {
        this._days.push(i);
    }

    const tailDatas = getPrevMonthTail(n);
    this._draft = this._days.map(d => {
       const existing = tailDatas.find(td => td.day === d);
       const offSet = existing ? new Set(existing.off) : new Set();
       return { day: d, off: offSet };
    });

    this._render();
    document.getElementById('prev-tail-modal').classList.add('open');
  },
  
  close() {
    document.getElementById('prev-tail-modal').classList.remove('open');
  },
  
  save() {
    this._syncFromDOM();
    const key = `${this._prevYear}-${this._prevMonth}`;
    let saved = STATE.monthlyData.get(key) || { leaveDays: [], summer: { enabled: false, memberId: null, startDay: 1 }, schedule: null };
    
    if (!saved.schedule) {
       saved.schedule = [];
       const totalDays = getDaysInMonth(this._prevYear, this._prevMonth);
       for (let i = 1; i <= totalDays; i++) {
           saved.schedule.push({
               day: i, dutyOfficer: null, working: [], off: [], headcount: 0, powerLevel: null, powerLabel: '', alerts: []
           });
       }
    }
    
    this._draft.forEach(d => {
       const idx = d.day - 1;
       if (saved.schedule[idx]) {
           saved.schedule[idx].off = Array.from(d.off);
       }
    });

    STATE.monthlyData.set(key, saved);
    
    if (STATE.schedule) {
      STATE.schedule = null;
      UI.renderCalendarGrid();
    }
    this.close();
    UI.showToast('✅ 前月尾巴資料已儲存', 'ok');
  },
  
  _syncFromDOM() {
    const rows = document.querySelectorAll('#prev-tail-tbody tr');
    rows.forEach(row => {
       const memberId = row.dataset.memberId;
       const checkboxes = row.querySelectorAll('.prev-tail-checkbox');
       checkboxes.forEach((cb, i) => {
           if (cb.checked) {
               this._draft[i].off.add(memberId);
           } else {
               this._draft[i].off.delete(memberId);
           }
       });
    });
  },

  _render() {
      const thead = document.getElementById('prev-tail-thead');
      thead.innerHTML = '<th>人員</th>' + this._days.map(d => `<th>${this._prevMonth}/${d}</th>`).join('');
      
      const tbody = document.getElementById('prev-tail-tbody');
      tbody.innerHTML = STATE.team.map(m => {
          let rowHtml = `<tr data-member-id="${m.id}"><td>${m.name}</td>`;
          this._draft.forEach(d => {
              const isChecked = d.off.has(m.id) ? 'checked' : '';
              rowHtml += `<td><input type="checkbox" class="prev-tail-checkbox" ${isChecked} style="width: 20px; height: 20px;"></td>`;
          });
          rowHtml += '</tr>';
          return rowHtml;
      }).join('');
  }
};

// =============================================
// 7. INIT
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  UI.init();
});
