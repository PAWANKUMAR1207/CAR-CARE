(() => {
  const USER_KEY = 'cc_user';
  const TOKEN_KEY = 'cc_token';
  const BOOKING_CONFIRMATION_KEY = 'cc_last_booking_confirmation';

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizePlate(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function isValidIndianPlate(value) {
    return /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/.test(normalizePlate(value));
  }

  function extractIndianPlateNumber(rawText) {
    const source = String(rawText || '').toUpperCase();
    const spaced = source.match(/([A-Z]{2})\s*[-]?\s*([0-9]{1,2})\s*[-]?\s*([A-Z]{1,3})\s*[-]?\s*([0-9]{4})/);
    if (spaced) {
      return `${spaced[1]}${spaced[2]}${spaced[3]}${spaced[4]}`.replace(/O/g, '0');
    }

    const compact = source.replace(/[^A-Z0-9]/g, '').replace(/O/g, '0');
    const pattern = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/;

    for (let start = 0; start < compact.length; start += 1) {
      for (let len = 8; len <= 11; len += 1) {
        const candidate = compact.slice(start, start + len);
        if (pattern.test(candidate)) {
          return candidate;
        }
      }
    }

    return '';
  }

  function getCurrentUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch (error) {
      return null;
    }
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setSession(user, token) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.setItem(TOKEN_KEY, token);
  }

  function clearSession() {
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(TOKEN_KEY);
  }

  function apiSync(method, url, body, options) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, false);
    xhr.setRequestHeader('Accept', 'application/json');

    const token = (options && options.token) || getToken();
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    let payload = null;
    if (body !== undefined && body !== null) {
      xhr.setRequestHeader('Content-Type', 'application/json');
      payload = JSON.stringify(body);
    }

    xhr.send(payload);

    let data = null;
    if (xhr.responseText) {
      try {
        data = JSON.parse(xhr.responseText);
      } catch (error) {
        data = null;
      }
    }

    if (xhr.status >= 200 && xhr.status < 300) {
      return data;
    }

    const msg = data && data.error ? data.error : `Request failed (${xhr.status})`;
    throw new Error(msg);
  }

  async function apiAsync(method, url, body, options) {
    const headers = {
      Accept: 'application/json'
    };
    const token = (options && options.token) || getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const init = {
      method,
      headers
    };

    if (body instanceof FormData) {
      delete headers['Content-Type'];
      init.body = body;
    } else if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }

    if (!response.ok) {
      const msg = data && data.error ? data.error : `Request failed (${response.status})`;
      throw new Error(msg);
    }

    return data;
  }

  function logout() {
    try {
      apiSync('POST', '/api/auth/logout');
    } catch (error) {
      // Session may already be invalid; ignore and clear local session anyway.
    }
    clearSession();
  }

  function login(email, password, role) {
    const result = apiSync('POST', '/api/auth/login', { email, password, role: role || '' });
    setSession(result.user, result.token);
    return clone(result.user);
  }

  function loginAs(email, password, role) {
    return login(email, password, role);
  }

  function register(name, email, password) {
    const result = apiSync('POST', '/api/auth/register', { name, email, password });
    setSession(result.user, result.token);
    return clone(result.user);
  }

  function listActiveBookings() {
    return apiSync('GET', '/api/bookings/active');
  }

  function listCompletedBookings() {
    return apiSync('GET', '/api/bookings/completed');
  }

  function createBooking(user, payload) {
    const booking = apiSync('POST', '/api/bookings', payload);
    localStorage.setItem(BOOKING_CONFIRMATION_KEY, JSON.stringify(booking));
    return booking;
  }

  function updateBookingStatus(user, bookingId, newStatus, payload) {
    return apiSync('POST', `/api/bookings/${encodeURIComponent(bookingId)}/status`, {
      status: newStatus,
      notes: payload && payload.notes ? payload.notes : '',
      imageDataUrl: payload && payload.imageDataUrl ? payload.imageDataUrl : '',
      imageName: payload && payload.imageName ? payload.imageName : ''
    });
  }

  function cancelBooking(user, bookingId, reason) {
    return apiSync('POST', `/api/bookings/${encodeURIComponent(bookingId)}/cancel`, {
      reason: String(reason || '').trim()
    });
  }

  function rescheduleBooking(user, bookingId, payload) {
    return apiSync('POST', `/api/bookings/${encodeURIComponent(bookingId)}/reschedule`, {
      date: payload.date,
      timeSlot: payload.timeSlot,
      centerId: payload.centerId,
      reason: String(payload.reason || '').trim()
    });
  }

  function listVehicles() {
    return apiSync('GET', '/api/vehicles');
  }

  function saveVehicle(user, payload, vehicleId) {
    if (vehicleId) {
      return apiSync('PUT', `/api/vehicles/${encodeURIComponent(vehicleId)}`, payload);
    }
    return apiSync('POST', '/api/vehicles', payload);
  }

  function deleteVehicle(user, vehicleId) {
    return apiSync('DELETE', `/api/vehicles/${encodeURIComponent(vehicleId)}`);
  }

  async function addDocument(user, vehicleId, documentType, file, expiryDate) {
    const formData = new FormData();
    formData.append('vehicleId', vehicleId);
    formData.append('documentType', documentType);
    if (expiryDate) {
      formData.append('expiryDate', expiryDate);
    }
    formData.append('file', file);
    return apiAsync('POST', '/api/documents', formData);
  }

  function listDocuments(user, vehicleId, vehicleNumber) {
    const params = new URLSearchParams();
    if (vehicleId) params.set('vehicleId', vehicleId);
    if (vehicleNumber) params.set('vehicleNumber', vehicleNumber);
    return apiSync('GET', `/api/documents?${params.toString()}`);
  }

  function getDocument(user, documentId) {
    return apiSync('GET', `/api/documents/${encodeURIComponent(documentId)}`);
  }

  function deleteDocument(user, documentId) {
    return apiSync('DELETE', `/api/documents/${encodeURIComponent(documentId)}`);
  }

  function listExpiringDocuments(withinDays) {
    const days = Number(withinDays || 30);
    return apiSync('GET', `/api/documents-expiring?withinDays=${encodeURIComponent(days)}`);
  }

  function listServiceHistory() {
    return apiSync('GET', '/api/history');
  }

  function listNotifications() {
    return apiSync('GET', '/api/notifications');
  }

  function listServiceUpdates(user, bookingId) {
    return apiSync('GET', `/api/service-updates/${encodeURIComponent(bookingId)}`);
  }

  function markNotificationsRead() {
    return apiSync('POST', '/api/notifications/read-all');
  }

  function getConfirmationDraft() {
    try {
      return JSON.parse(localStorage.getItem(BOOKING_CONFIRMATION_KEY) || 'null');
    } catch (error) {
      return null;
    }
  }

  function clearConfirmationDraft() {
    localStorage.removeItem(BOOKING_CONFIRMATION_KEY);
  }

  function getServiceCatalog() {
    return apiSync('GET', '/api/meta/service-catalog');
  }

  function getStatusStages() {
    return apiSync('GET', '/api/meta/status-stages');
  }

  function getServiceCenters() {
    return apiSync('GET', '/api/meta/service-centers');
  }

  function getDashboardStats() {
    return apiSync('GET', '/api/stats');
  }

  function getHeuristicQuote(payload) {
    return apiSync('POST', '/api/heuristics/quote', payload || {});
  }

  function listMaintenanceRecommendations() {
    return apiSync('GET', '/api/heuristics/maintenance');
  }

  async function downloadInvoicePdf(bookingId) {
    const token = getToken();
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(`/api/invoices/${encodeURIComponent(bookingId)}/pdf`, {
      method: 'GET',
      headers
    });
    if (!response.ok) {
      let msg = `Request failed (${response.status})`;
      try {
        const body = await response.json();
        if (body && body.error) {
          msg = body.error;
        }
      } catch (error) {
        // ignore parse errors
      }
      throw new Error(msg);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const content = response.headers.get('Content-Disposition') || '';
    const match = content.match(/filename=\"?([^\"]+)\"?/i);
    const filename = match ? match[1] : `invoice-${bookingId}.pdf`;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.CarSevaStore = {
    getServiceCatalog,
    getStatusStages,
    getServiceCenters,
    normalizePlate,
    isValidIndianPlate,
    extractIndianPlateNumber,
    getCurrentUser,
    getToken,
    logout,
    login,
    loginAs,
    register,
    listActiveBookings,
    listCompletedBookings,
    createBooking,
    updateBookingStatus,
    cancelBooking,
    rescheduleBooking,
    listVehicles,
    saveVehicle,
    deleteVehicle,
    addDocument,
    listDocuments,
    getDocument,
    deleteDocument,
    listExpiringDocuments,
    listServiceHistory,
    listNotifications,
    listServiceUpdates,
    markNotificationsRead,
    getConfirmationDraft,
    clearConfirmationDraft,
    getDashboardStats,
    getHeuristicQuote,
    listMaintenanceRecommendations,
    downloadInvoicePdf
  };
})();
