(() => {
  'use strict';

  // Snapshots are memory-only. No browser credential is needed or stored.
  let snapshot = null;
  let accountSnapshot = null;
  let busy = false;
  let generation = 0;
  let controller = null;
  let timer = null;
  let search = '';
  let snapshotSearch = '';
  let page = 1;
  let stale = false;
  const $ = id => document.getElementById(id);
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const count = value => typeof value === 'number' && Number.isFinite(value) ? number.format(value) : '—';
  const date = value => {
    if (!value) return 'Not available';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Not available' : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };
  const bytes = value => {
    if (!Number.isFinite(value)) return '—';
    if (value < 1024) return `${count(value)} B`;
    const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
    return `${decimal.format(value / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`;
  };
  const length = (meters, estimated) => Number.isFinite(meters)
    ? `${estimated ? '≈ ' : ''}${decimal.format(meters / 1000)} km${estimated ? ' estimated' : ''}` : '—';
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function set(id, text) { $(id).textContent = text; }
  function stopTimer() { clearInterval(timer); timer = null; }
  function configureTimer() {
    stopTimer();
    if ($('auto-refresh').checked) {
      timer = setInterval(() => {
        if (!busy && !document.hidden) refresh();
      }, 30000);
    }
  }
  function updateControls() {
    if (!snapshot) $('assignment-form').hidden = true;
    for (const id of ['refresh', 'period', 'previous', 'next', 'course-search', 'clear-search', 'profile-key', 'course-id']) $(id).disabled = busy;
    $('search-form').querySelector('button[type="submit"]').disabled = busy;
    if (!busy) {
      $('previous').disabled = !snapshot || snapshot.courses.page <= 1;
      $('next').disabled = !snapshot || snapshot.courses.page * snapshot.courses.pageSize >= snapshot.courses.total;
    }
    $('assign-submit').disabled = busy || stale || !snapshot || !$('profile-key').value || !$('course-id').value;
    $('snapshot').setAttribute('aria-busy', String(busy));
    $('refresh').textContent = busy ? 'Updating…' : '↻ Refresh';
  }
  class RequestError extends Error {
    constructor(status) { super('Request failed'); this.status = status; }
  }
  async function api(path, signal, body) {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'X-Local-Admin': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: 'omit', cache: 'no-store', mode: 'same-origin', redirect: 'error', signal
    });
    if (!response.ok) throw new RequestError(response.status);
    return response.json();
  }
  function messageFor(error) {
    if (error.status === 503) return 'Supabase administration unavailable. Configure the local Supabase connection and deploy the admin migrations, then retry.';
    if (error.status === 403) return 'Local security check rejected this request. Open the dashboard directly using its loopback address.';
    if (error.status === 429) return 'Too many requests. Wait a moment before retrying.';
    if (error.status === 400 || error.status === 404) return 'This selection is no longer available. Refresh the snapshot and try again.';
    return 'Could not reach a valid admin response. Check the connection and try again.';
  }
  function validSnapshot(data) {
    // Reject incomplete responses rather than presenting missing values as zeros.
    return data && typeof data.generatedAt === 'string' && data.period && data.traffic && data.inventory
      && Array.isArray(data.providers) && Array.isArray(data.daily) && Array.isArray(data.courses?.items)
      && Number.isInteger(data.courses.page) && data.courses.pageSize > 0
      && Array.isArray(data.unassigned?.items) && Array.isArray(data.courseOptions);
  }
  async function refresh(successMessage = '') {
    if (busy) return;
    busy = true;
    const current = generation;
    controller = new AbortController();
    const params = new URLSearchParams({ days: $('period').value, search, page: String(page) });
    set('notice', snapshot ? 'Updating snapshot and users & storage… Last successful data remains visible.' : 'Loading private snapshot, then users & storage…');
    updateControls();
    try {
      let data = await api(`/api/admin/overview?${params}`, controller.signal);
      if (current !== generation) return;
      if (!validSnapshot(data)) throw new Error('Invalid snapshot');
      // A deletion or association may reduce the number of available pages.
      const lastPage = Math.max(1, Math.ceil(data.courses.total / data.courses.pageSize));
      if (data.courses.page > lastPage) {
        params.set('page', String(lastPage));
        data = await api(`/api/admin/overview?${params}`, controller.signal);
        if (current !== generation) return;
        if (!validSnapshot(data)) throw new Error('Invalid snapshot');
      }
      const firstSnapshot = !snapshot;
      snapshot = data;
      snapshotSearch = search;
      page = data.courses.page;
      stale = false;
      $('period').value = String(data.period.days);
      render(data);
      set('assignment-status', '');
      set('notice', successMessage);
      configureTimer();
      if (firstSnapshot) $('main').focus();
      // Accounts have a separate in-memory cache and failure state.
      await loadAccountMetrics(current, controller.signal);
    } catch (error) {
      if (current !== generation || error.name === 'AbortError') return;
      if (!snapshot) {
        stale = true;
        set('notice', messageFor(error));
        await loadAccountMetrics(current, controller.signal);
        return;
      }
      stale = true;
      $('period').value = String(snapshot.period.days);
      page = snapshot.courses.page;
      search = snapshotSearch;
      $('course-search').value = snapshotSearch;
      accountFailure('Account metrics were not refreshed because the overview request failed.');
      set('notice', `${messageFor(error)} Showing the last successful snapshot (${snapshot.period.label}); data may be stale. Associations are paused until refresh succeeds.`);
    } finally {
      if (current === generation) { busy = false; controller = null; updateControls(); }
    }
  }
  function validAccountData(data) {
    const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
    const validCount = value => Number.isSafeInteger(value) && value >= 0;
    return data?.schemaVersion === 1 && validDate(data.generatedAt) && validDate(data.trackingStartedAt)
      && typeof data.historyComplete === 'boolean' && data.activityDefinition === 'signed_in_last_30_days'
      && ['current', 'active30d', 'knownRegistrations', 'knownDeletions'].every(key => validCount(data.users?.[key]))
      && ['currentUserSyncBytes', 'recordsBytes', 'historyBytes', 'receiptsBytes', 'averageBytesPerUser',
        'maxBytesPerUser', 'syncPhysicalBytes', 'databaseBytes'].every(key => validCount(data.storage?.[key]))
      && data.storage.objectStorageBytes === null;
  }
  function renderAccountMetrics(result) {
    const { data, fetchedAt } = result;
    const { users, storage } = data;
    set('accounts-current', count(users.current));
    set('accounts-active', count(users.active30d));
    set('accounts-registrations', `${count(users.knownRegistrations)}${data.historyComplete ? '' : '+'}`);
    set('accounts-registration-note', data.historyComplete
      ? 'Includes known deleted accounts. Accounts, not unique humans.'
      : 'Lower bound, including known deleted accounts. Earlier physically deleted accounts are unknown.');
    set('accounts-deletions', count(users.knownDeletions));
    set('accounts-time', `Account snapshot ${date(data.generatedAt)} · Fetched by server ${date(fetchedAt)} · Not filtered by traffic period`);
    set('accounts-tracking', `Account tracking began ${date(data.trackingStartedAt)}. ${data.historyComplete ? 'Registration history is marked complete.' : 'Registration history is incomplete; known registrations are a lower bound, not a lifetime total.'}`);
    const host = $('accounts-storage');
    host.replaceChildren();
    for (const [label, value, note] of [
      ['Current-user logical sync', bytes(storage.currentUserSyncBytes), 'Total JSONB payload estimate for current accounts; not billed storage.'],
      ['Average per current account', bytes(storage.averageBytesPerUser), 'Includes accounts with zero sync bytes; rounded up to a whole byte.'],
      ['Maximum per current account', bytes(storage.maxBytesPerUser), 'Largest logical sync estimate for one current account.'],
      ['Records', bytes(storage.recordsBytes), 'Current-user record payloads, including tombstones.'],
      ['History', bytes(storage.historyBytes), 'Current-user sync history payloads.'],
      ['Receipts', bytes(storage.receiptsBytes), 'Current-user sync receipt payloads.'],
      ['Physical sync tables', bytes(storage.syncPhysicalBytes), 'Shared tables, all rows and indexes; not per-user storage.'],
      ['Whole project database', bytes(storage.databaseBytes), 'Total project database size, not just users or sync data.'],
      ['Object storage', 'Unknown', 'Not measured; unknown does not mean zero.']
    ]) {
      const item = element('div', undefined, 'storage-stat');
      const valueNode = element('dd', value);
      valueNode.append(element('p', note));
      item.append(element('dt', label), valueNode);
      host.append(item);
    }
  }
  function accountFailure(message) {
    set('accounts-status', accountSnapshot ? 'Stale' : 'Unavailable');
    set('accounts-notice', `${message} ${accountSnapshot ? 'Showing the last available account snapshot; these figures are stale.' : 'Account figures are unavailable, not zero.'} Account metrics and hosted-cache monitoring have separate availability.`);
  }
  async function loadAccountMetrics(current, parentSignal) {
    // This child deadline never aborts overview or association controllers.
    const accountController = new AbortController();
    const abort = () => accountController.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    if (parentSignal.aborted) abort();
    // Allow the server's 10-second upstream timeout to return its stale envelope.
    const deadline = setTimeout(abort, 15000);
    $('accounts').setAttribute('aria-busy', 'true');
    set('accounts-status', 'Loading');
    set('accounts-notice', `Loading users & storage (up to 15 seconds)…${accountSnapshot ? ' Previous account figures remain visible until this check completes.' : ''}`);
    try {
      const result = await api('/api/admin/accounts', accountController.signal);
      if (current !== generation || parentSignal.aborted) return;
      if (!result || !['ready', 'disabled', 'unavailable'].includes(result.status)
        || typeof result.message !== 'string'
        || !(result.fetchedAt === null || (typeof result.fetchedAt === 'string' && Number.isFinite(Date.parse(result.fetchedAt))))
        || !(result.data === null || validAccountData(result.data))
        || (result.status === 'ready' && (!result.data || !result.fetchedAt))) throw new Error('Invalid account snapshot');
      if (result.data) {
        accountSnapshot = { data: result.data, fetchedAt: result.fetchedAt };
        renderAccountMetrics(accountSnapshot);
      }
      if (result.status === 'ready') {
        set('accounts-status', 'Ready');
        set('accounts-notice', '');
      } else if (result.status === 'disabled') {
        accountFailure('Account metrics are not configured. Operator setup: apply the account metrics migration first, then configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server only, never in this browser.');
        if (!accountSnapshot) set('accounts-status', 'Not configured');
      } else {
        accountFailure('Account metrics are temporarily unavailable. If setup is incomplete, the operator must apply the account metrics migration first, then configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server only, never in this browser.');
      }
    } catch (error) {
      if (current !== generation || parentSignal.aborted) return;
      accountFailure(error.name === 'AbortError'
        ? 'The account metrics request timed out. Try Refresh again.'
        : 'Account metrics could not be loaded. The optional endpoint may be unavailable or not yet deployed.');
    } finally {
      clearTimeout(deadline);
      parentSignal.removeEventListener('abort', abort);
      if (current === generation) $('accounts').setAttribute('aria-busy', 'false');
    }
  }
  function svgNode(tag, attributes, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function renderChart(daily) {
    const days = daily.slice(-30);
    const host = $('traffic-chart');
    host.replaceChildren();
    $('daily-rows').replaceChildren();
    if (!days.length) { host.append(element('p', 'No daily traffic has been recorded yet.', 'empty')); return; }
    const svg = svgNode('svg', { viewBox: '0 0 660 230', role: 'img', 'aria-labelledby': 'chart-title chart-description' });
    svg.append(svgNode('title', { id: 'chart-title' }, 'Daily client requests and upstream attempts'));
    svg.append(svgNode('desc', { id: 'chart-description' }, 'Grouped bars use a shared count axis. Exact daily counts and outcomes are available in the table below. Upstream history can predate client tracking.'));
    const maximum = Math.max(1, ...days.flatMap(day => [day.requests, day.upstreamCalls]));
    const left = 48, width = 598, height = 165, baseline = 190;
    for (let index = 0; index <= 3; index += 1) {
      const y = baseline - index * height / 3;
      svg.append(svgNode('line', { x1: left, x2: 652, y1: y, y2: y, class: 'chart-grid' }));
      svg.append(svgNode('text', { x: 40, y: y + 3, 'text-anchor': 'end', class: 'chart-label' }, count(Math.ceil(maximum * index / 3))));
    }
    const slot = width / days.length;
    const barWidth = Math.min(22, slot * .31);
    days.forEach((day, index) => {
      const x = left + slot * (index + .5);
      for (const [field, offset, className, label] of [['requests', -barWidth - 1, 'chart-client', 'Client requests'], ['upstreamCalls', 1, 'chart-upstream', 'Upstream attempts']]) {
        const barHeight = Math.max(0, day[field]) / maximum * height;
        const bar = svgNode('rect', { x: x + offset, y: baseline - barHeight, width: barWidth, height: barHeight, rx: 2, class: className });
        bar.append(svgNode('title', {}, `${day.day}: ${label} ${count(day[field])}`));
        svg.append(bar);
      }
      if (index === 0 || index === days.length - 1 || (days.length > 4 && index % Math.ceil(days.length / 4) === 0)) {
        svg.append(svgNode('text', { x, y: 214, 'text-anchor': 'middle', class: 'chart-label' }, day.day.slice(5)));
      }
      const row = element('tr');
      row.append(element('th', day.day));
      row.firstChild.scope = 'row';
      for (const field of ['requests', 'cacheHits', 'coalesced', 'upstreamCalls', 'errors']) row.append(element('td', count(day[field])));
      $('daily-rows').append(row);
    });
    host.append(svg);
    if (days.every(day => day.requests === 0 && day.upstreamCalls === 0)) host.append(element('p', 'No recorded traffic in this trend window.', 'help'));
  }
  function renderProviders(providers) {
    const host = $('providers');
    host.replaceChildren();
    if (!providers.length) host.append(element('p', 'No provider budget information available.', 'empty'));
    for (const provider of providers) {
      const card = element('article', undefined, 'provider');
      const heading = element('div', undefined, 'provider-head');
      heading.append(element('h3', provider.name), element('span', provider.enabled === true ? 'Enabled' : provider.enabled === false ? 'Disabled' : 'Status unavailable', 'pill'));
      const budget = element('div', undefined, 'provider-budget');
      budget.append(element('strong', `${count(provider.todayCalls)} / ${count(provider.dailyLimit)}`), element('span', 'attempts today'));
      card.append(heading, budget);
      if (Number.isFinite(provider.dailyLimit) && provider.dailyLimit > 0 && Number.isFinite(provider.todayCalls)) {
        const meter = element('meter', `${count(provider.todayCalls)} of ${count(provider.dailyLimit)}`, 'budget-meter');
        meter.min = 0; meter.max = provider.dailyLimit; meter.value = provider.todayCalls;
        meter.setAttribute('aria-label', `${provider.name} daily attempt budget`);
        card.append(meter);
      }
      card.append(element('p', `${count(provider.upstreamCalls)} attempts in selected period · ${count(provider.cooldownSeconds)}s cooldown`, 'help'));
      host.append(card);
    }
  }
  function cell(primary, secondary) {
    const node = element('td');
    node.append(element('strong', primary));
    if (secondary) node.append(element('small', secondary));
    return node;
  }
  function renderCourses(courses) {
    const host = $('course-rows');
    host.replaceChildren();
    for (const course of courses.items) {
      const row = element('tr');
      const title = cell(course.name, `ID ${course.id} · ${course.country || 'Location unavailable'}`);
      if (course.clubName) title.append(element('small', course.clubName));
      const metadata = element('td');
      metadata.append(element('span', `Detail: ${course.hasDetail ? 'Cached' : 'Not cached'}`, 'cell-line'));
      metadata.append(element('span', `GPS: ${course.hasCoordinates ? `${count(course.coordinateCount)} coordinates` : 'Not cached'}`, 'cell-line'));
      metadata.append(element('small', course.numHoles == null ? 'Hole count unavailable' : `${count(course.numHoles)} holes`));
      const elevation = course.elevation;
      const dates = element('td');
      dates.append(element('small', `Detail: ${date(course.detailFetchedAt)}`), element('small', `GPS: ${date(course.coordinatesFetchedAt)}`), element('small', `Elevation: ${date(elevation.lastFetchedAt)}`));
      row.append(title, metadata, cell(`${count(elevation.profiles)} profiles`, `${count(elevation.samples)} samples`), cell(length(elevation.lengthMeters, elevation.lengthEstimated), bytes(elevation.bytes)), dates);
      host.append(row);
    }
    $('courses-empty').hidden = courses.items.length > 0;
    set('courses-empty', search ? 'No cached courses match this search. Try another name, ID, club or country.' : 'No cached courses yet. Course data appears here after normal client activity; this dashboard never fetches paid data.');
    const start = courses.total ? (courses.page - 1) * courses.pageSize + 1 : 0;
    const end = Math.min(courses.page * courses.pageSize, courses.total);
    set('page-summary', `${count(start)}–${count(end)} of ${count(courses.total)} courses · Page ${count(courses.page)}`);
  }
  function coordinates(point) {
    return point && Number.isFinite(point.lat) && Number.isFinite(point.lon) ? `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` : 'Not available';
  }
  function renderProfile() {
    const host = $('profile-detail');
    host.replaceChildren();
    const profile = snapshot?.unassigned.items.find(item => item.key === $('profile-key').value);
    if (!profile) return;
    for (const [label, value] of [['Samples / storage', `${count(profile.samples)} / ${bytes(profile.bytes)}`], ['Path length', length(profile.lengthMeters, profile.lengthEstimated)], ['Fetched', date(profile.fetchedAt)], ['Start · lat, lon', coordinates(profile.start)], ['End · lat, lon', coordinates(profile.end)]]) {
      const field = element('div');
      field.append(element('small', label), element('span', value));
      host.append(field);
    }
    host.append(element('div', profile.key, 'profile-key'));
    updateControls();
  }
  function renderAssociations(data) {
    const previousProfile = $('profile-key').value;
    const previousCourse = $('course-id').value;
    $('profile-key').replaceChildren();
    $('course-id').replaceChildren();
    function option(select, value, label) {
      const item = element('option', label);
      item.value = String(value);
      select.append(item);
    }
    option($('profile-key'), '', 'Select a stored profile…');
    for (const [index, profile] of data.unassigned.items.entries()) option($('profile-key'), profile.key, `${index + 1}. ${count(profile.samples)} samples · ${length(profile.lengthMeters, profile.lengthEstimated)} · ${date(profile.fetchedAt)}`);
    option($('course-id'), '', 'Select a known cached course…');
    for (const course of data.courseOptions) option($('course-id'), course.id, `${course.name} · ${course.id}`);
    if (data.unassigned.items.some(item => item.key === previousProfile)) $('profile-key').value = previousProfile;
    if (data.courseOptions.some(item => String(item.id) === previousCourse)) $('course-id').value = previousCourse;
    set('unassigned-count', `${count(data.unassigned.total)} unassigned`);
    const available = data.unassigned.items.length > 0 && data.courseOptions.length > 0;
    $('assignment-form').hidden = !available;
    $('assignment-empty').hidden = available;
    set('assignment-empty', data.unassigned.total === 0 ? 'All stored profiles are associated, or no elevation profiles have been cached yet.' : 'Profiles are available, but there are no known cached courses to associate. No course data will be fetched here.');
    renderProfile();
  }
  function render(data) {
    const { traffic, inventory } = data;
    set('snapshot-time', `Snapshot ${date(data.generatedAt)}`);
    set('metric-requests', count(traffic.requests));
    set('requests-note', `${data.period.label} · ${count(traffic.completed)} terminal RPC outcomes`);
    set('metric-hitrate', traffic.cacheHitRate == null ? '—' : `${decimal.format(traffic.cacheHitRate * 100)}%`);
    set('hitrate-note', traffic.cacheHitRate == null ? 'No terminal RPC outcomes in this period' : `${count(traffic.cacheHits)} hits / ${count(traffic.completed)} terminal RPC outcomes`);
    set('metric-upstream', count(traffic.upstreamCalls));
    set('upstream-note', `${data.period.label} · attempted provider calls`);
    set('metric-samples', count(inventory.elevationSamples));
    set('trend-period', data.period.days === 0 ? 'Last 30 days' : data.period.label);
    set('tracking-note', `Cloud counters began ${date(data.trackingStartedAt)}. ${count(traffic.fetched)} persisted fetches · ${count(traffic.coalesced)} PENDING waiters · ${count(traffic.errors)} recorded errors in period. These are database events, not guaranteed HTTP deliveries. Pending callers receive a retry response; retrying counts as another request. Upstream attempts include reservations that may have an uncertain outcome. Trend shows at most 30 days; all-time totals are not truncated.`);
    renderChart(data.daily);
    renderProviders(data.providers);
    const stats = $('inventory-stats');
    stats.replaceChildren();
    for (const [value, label] of [[count(inventory.courseCount), 'Cached courses'], [count(inventory.elevationProfiles), 'Elevation profiles'], [length(inventory.elevationLengthMeters, inventory.lengthEstimated), 'Stored path length'], [bytes(inventory.elevationBytes), 'Elevation storage'], [count(inventory.unassignedProfiles), 'Unassigned profiles']]) {
      const item = element('div', undefined, 'inventory-stat');
      item.append(element('strong', value), element('span', label));
      stats.append(item);
    }
    renderCourses(data.courses);
    renderAssociations(data);
  }
  $('refresh').addEventListener('click', () => refresh());
  $('period').addEventListener('change', () => { page = 1; refresh(); });
  $('auto-refresh').addEventListener('change', configureTimer);
  $('search-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    search = $('course-search').value.trim(); page = 1; refresh();
  });
  $('clear-search').addEventListener('click', () => { if (busy) return; $('course-search').value = ''; search = ''; page = 1; refresh(); });
  $('previous').addEventListener('click', () => { if (!busy && page > 1) { page -= 1; refresh(); } });
  $('next').addEventListener('click', () => { if (!busy && snapshot && page * snapshot.courses.pageSize < snapshot.courses.total) { page += 1; refresh(); } });
  $('profile-key').addEventListener('change', renderProfile);
  $('course-id').addEventListener('change', updateControls);
  $('assignment-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || stale || !snapshot) return;
    const key = $('profile-key').value, courseID = $('course-id').value;
    if (!snapshot.unassigned.items.some(item => item.key === key) || !snapshot.courseOptions.some(item => String(item.id) === courseID)) return;
    busy = true;
    const current = generation;
    controller = new AbortController();
    let success = false;
    set('assignment-status', 'Associating the stored profile…');
    updateControls();
    try {
      const result = await api('/api/admin/elevation/assign', controller.signal, { key, courseID });
      if (current !== generation) return;
      if (result.ok !== true) throw new Error('Invalid association response');
      success = true;
      set('assignment-status', 'Association saved. Inventory below reflects the last successful snapshot until refresh succeeds.');
    } catch (error) {
      if (current !== generation || error.name === 'AbortError') return;
      // A network failure may occur after the write committed. Do not invite a blind retry.
      stale = true;
      set('assignment-status', `${messageFor(error)} The association was not confirmed; refresh before attempting another change.`);
    } finally {
      if (current === generation) { busy = false; controller = null; updateControls(); }
    }
    if (success && current === generation) await refresh('Profile association saved. Hosted inventory updated.');
  });
  window.addEventListener('pagehide', () => { generation += 1; controller?.abort(); stopTimer(); });
  updateControls();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => refresh(), { once: true });
  else refresh();
})();