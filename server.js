require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'carcare.db');
const STATUS_STAGES = ['Received', 'Inspection', 'In Progress', 'Completed'];
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const SLOT_CAPACITY_PER_CENTER = 4;
const CUSTOMER_CUTOFF_HOURS = 4;

const SERVICE_CATALOG = [
  {
    id: 'oil-change',
    name: 'Oil Change',
    category: 'Maintenance',
    price: 1200,
    duration: '45 mins',
    description: 'Engine oil and filter replacement with quick fluid inspection.',
    tags: ['maintenance', 'quick', 'popular']
  },
  {
    id: 'general-service',
    name: 'General Service',
    category: 'Inspection',
    price: 2500,
    duration: '2 hrs',
    description: 'Full service check covering fluids, brakes, tyres, and diagnostics.',
    tags: ['inspection', 'popular', 'full-check']
  },
  {
    id: 'maintenance',
    name: 'Maintenance',
    category: 'Preventive Care',
    price: 4000,
    duration: '3 hrs',
    description: 'Preventive maintenance package with tune-up and key replacements.',
    tags: ['preventive', 'premium']
  },
  {
    id: 'ac-service',
    name: 'AC Service',
    category: 'Climate',
    price: 2800,
    duration: '90 mins',
    description: 'Cooling performance check, gas top-up, and vent cleaning.',
    tags: ['cooling', 'summer']
  },
  {
    id: 'battery-check',
    name: 'Battery Check',
    category: 'Electrical',
    price: 900,
    duration: '30 mins',
    description: 'Battery health report with terminal cleaning and charging advice.',
    tags: ['electrical', 'quick']
  },
  {
    id: 'wheel-alignment',
    name: 'Wheel Alignment',
    category: 'Tyres',
    price: 1500,
    duration: '60 mins',
    description: 'Precision alignment and balance correction for smoother driving.',
    tags: ['tyres', 'stability']
  },
  {
    id: 'car-wash',
    name: 'Car Wash',
    category: 'Detailing',
    price: 700,
    duration: '30 mins',
    description: 'Exterior foam wash and interior vacuum clean-up.',
    tags: ['detailing', 'quick']
  }
];

const SERVICE_CENTERS = [
  {
    id: 'blr-indiranagar',
    name: 'CarSeva Indiranagar Hub',
    city: 'Bengaluru',
    area: 'Indiranagar',
    address: '100 Feet Road, Indiranagar',
    distanceKm: 3.2,
    supportedCategories: ['Maintenance', 'Inspection', 'Electrical', 'Detailing']
  },
  {
    id: 'blr-whitefield',
    name: 'CarSeva Whitefield Works',
    city: 'Bengaluru',
    area: 'Whitefield',
    address: 'ITPL Main Road, Whitefield',
    distanceKm: 8.5,
    supportedCategories: ['Climate', 'Tyres', 'Inspection', 'Preventive Care']
  },
  {
    id: 'hyd-gachibowli',
    name: 'CarSeva Gachibowli Garage',
    city: 'Hyderabad',
    area: 'Gachibowli',
    address: 'Financial District Road, Gachibowli',
    distanceKm: 5.4,
    supportedCategories: ['Maintenance', 'Climate', 'Electrical', 'Tyres']
  },
  {
    id: 'chn-omr',
    name: 'CarSeva OMR Center',
    city: 'Chennai',
    area: 'OMR',
    address: 'Rajiv Gandhi Salai, OMR',
    distanceKm: 6.8,
    supportedCategories: ['Inspection', 'Preventive Care', 'Detailing']
  }
];

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePlate(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isValidIndianPlate(value) {
  return /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/.test(normalizePlate(value));
}

function jsonParseSafe(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    name: row.name
  };
}

function canMechanicAccess(user) {
  return user && (user.role === 'mechanic' || user.role === 'admin');
}

function getServiceByName(name) {
  return SERVICE_CATALOG.find((item) => item.name === String(name || '').trim()) || null;
}

function getCenterById(centerId) {
  return SERVICE_CENTERS.find((item) => item.id === String(centerId || '').trim()) || null;
}

function getServiceById(serviceId) {
  return SERVICE_CATALOG.find((item) => item.id === String(serviceId || '').trim()) || null;
}

function getSlotStartHour(timeSlot) {
  const source = String(timeSlot || '');
  if (source.includes('7:00 AM')) return 7;
  if (source.includes('9:00 AM')) return 9;
  if (source.includes('12:00 PM')) return 12;
  if (source.includes('3:00 PM')) return 15;
  if (source.includes('6:00 PM')) return 18;
  return 9;
}

function bookingDateTimeMs(date, timeSlot) {
  const hour = getSlotStartHour(timeSlot);
  const datePart = String(date || '').trim();
  const h = String(hour).padStart(2, '0');
  const dt = new Date(`${datePart}T${h}:00:00`);
  return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
}

function isWeekend(dateValue) {
  const dt = new Date(`${String(dateValue || '').trim()}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return false;
  const day = dt.getDay();
  return day === 0 || day === 6;
}

function canCustomerEditSlot(booking) {
  const scheduleMs = bookingDateTimeMs(booking.date, booking.timeSlot);
  if (!scheduleMs) return false;
  return (scheduleMs - Date.now()) >= (CUSTOMER_CUTOFF_HOURS * 60 * 60 * 1000);
}

async function hasSlotCapacity(centerId, date, timeSlot, ignoreBookingId) {
  const rows = await get(
    `SELECT COUNT(*) AS count
     FROM bookings
     WHERE center_id = ?
       AND date = ?
       AND time_slot = ?
       AND status NOT IN ('Cancelled', 'Completed')`
       + (ignoreBookingId ? ' AND id != ?' : ''),
    ignoreBookingId ? [centerId, date, timeSlot, ignoreBookingId] : [centerId, date, timeSlot]
  );
  return Number(rows ? rows.count : 0) < SLOT_CAPACITY_PER_CENTER;
}

function mapBookingRow(row) {
  return {
    id: row.id,
    bookingReference: row.booking_reference,
    userId: row.user_id,
    userEmail: row.user_email,
    customerName: row.customer_name || '',
    vehicleId: row.vehicle_id || '',
    vehicleName: row.vehicle_name,
    vehicleNumber: row.vehicle_number,
    serviceType: row.service_type,
    serviceCategory: row.service_category || '',
    servicePrice: Number(row.service_price || 0),
    centerId: row.center_id || '',
    centerName: row.center_name || '',
    centerCity: row.center_city || '',
    date: row.date,
    timeSlot: row.time_slot,
    status: row.status,
    timeline: jsonParseSafe(row.timeline_json, []),
    mechanicNotes: row.mechanic_notes || '',
    updateImages: jsonParseSafe(row.update_images_json, []),
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
    notes: row.notes || ''
  };
}

function makeTimeline(status, note, actorName = 'System') {
  return [{
    id: uid('timeline'),
    status,
    note: note || `${status} recorded`,
    createdAt: nowIso(),
    actorName
  }];
}

async function addNotification(payload) {
  await run(
    `INSERT INTO notifications (
      id, user_id, type, title, message, created_at, read, booking_id, booking_reference
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uid('note'),
      payload.userId,
      payload.type,
      payload.title,
      payload.message,
      nowIso(),
      0,
      payload.bookingId || null,
      payload.bookingReference || null
    ]
  );
}

async function buildInvoiceForBooking(booking) {
  const base = Number(booking.servicePrice || 0);
  const tax = Number((base * 0.18).toFixed(2));
  const total = Number((base + tax).toFixed(2));
  const invoice = {
    id: uid('invoice'),
    invoiceId: `INV-${Date.now()}`,
    bookingId: booking.id,
    userId: booking.userId,
    userEmail: booking.userEmail,
    vehicleName: booking.vehicleName,
    serviceType: booking.serviceType,
    cost: base,
    tax,
    total,
    generatedAt: nowIso()
  };

  await run(
    `INSERT INTO invoices (
      id, invoice_id, booking_id, user_id, user_email, vehicle_name, service_type, cost, tax, total, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invoice.id,
      invoice.invoiceId,
      invoice.bookingId,
      invoice.userId,
      invoice.userEmail,
      invoice.vehicleName,
      invoice.serviceType,
      invoice.cost,
      invoice.tax,
      invoice.total,
      invoice.generatedAt
    ]
  );

  return invoice;
}

async function getInvoiceByBookingId(bookingId) {
  const row = await get('SELECT * FROM invoices WHERE booking_id = ?', [bookingId]);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    bookingId: row.booking_id,
    userId: row.user_id,
    userEmail: row.user_email,
    vehicleName: row.vehicle_name,
    serviceType: row.service_type,
    cost: Number(row.cost || 0),
    tax: Number(row.tax || 0),
    total: Number(row.total || 0),
    generatedAt: row.generated_at
  };
}

function round2(value) {
  return Number((Number(value || 0)).toFixed(2));
}

async function buildHeuristicQuote(input) {
  const service = input.service || null;
  const center = input.center || null;
  const vehicle = input.vehicle || null;
  const userId = input.userId;
  const date = String(input.date || '').trim();
  const timeSlot = String(input.timeSlot || '').trim();

  const basePrice = Number(service ? service.price : 1800);
  let working = basePrice;
  const adjustments = [];

  function applyRule(code, label, amount) {
    const value = round2(amount);
    if (!value) return;
    working = round2(working + value);
    adjustments.push({
      code,
      label,
      amount: value,
      direction: value >= 0 ? 'up' : 'down'
    });
  }

  if (vehicle && Number.isFinite(Number(vehicle.year))) {
    const yearNow = new Date().getFullYear();
    const age = Math.max(0, yearNow - Number(vehicle.year));
    if (age >= 8) {
      applyRule('vehicle_age_high', `Older vehicle (${age} years) deep-check load`, basePrice * 0.12);
    } else if (age >= 5) {
      applyRule('vehicle_age_mid', `Vehicle age uplift (${age} years)`, basePrice * 0.08);
    } else if (age >= 3) {
      applyRule('vehicle_age_low', `Preventive wear uplift (${age} years)`, basePrice * 0.04);
    }
  }

  if (isWeekend(date)) {
    applyRule('weekend', 'Weekend slot demand', basePrice * 0.05);
  }

  if (timeSlot.includes('Evening') || timeSlot.includes('Late Evening')) {
    applyRule('peak_slot', 'Peak slot load', basePrice * 0.06);
  }
  if (timeSlot.includes('Early Morning')) {
    applyRule('offpeak_slot', 'Off-peak slot concession', basePrice * -0.03);
  }

  if (center && Number(center.distanceKm || 0) > 7) {
    applyRule('distance_center', 'Extended center logistics', basePrice * 0.02);
  }

  const completedRow = await get(
    "SELECT COUNT(*) AS count FROM bookings WHERE user_id = ? AND status = 'Completed'",
    [userId]
  );
  const completedCount = Number(completedRow ? completedRow.count : 0);
  if (completedCount >= 8) {
    applyRule('loyalty_plus', `Loyalty discount (${completedCount} completed services)`, basePrice * -0.08);
  } else if (completedCount >= 3) {
    applyRule('loyalty', `Returning customer discount (${completedCount} completed services)`, basePrice * -0.05);
  }

  const predictedBase = Math.max(400, round2(working));
  const tax = round2(predictedBase * 0.18);
  const total = round2(predictedBase + tax);
  const confidence = Math.min(0.95, 0.55 + (adjustments.length * 0.07));

  return {
    basePrice: round2(basePrice),
    predictedBase,
    tax,
    total,
    confidence: round2(confidence),
    adjustments
  };
}

async function buildMaintenanceRecommendations(userId) {
  const vehicles = await all('SELECT * FROM vehicles WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  const now = Date.now();
  const result = [];

  for (const vehicle of vehicles) {
    const recs = [];
    const year = Number(vehicle.year || 0);
    const age = year > 0 ? Math.max(0, new Date().getFullYear() - year) : 0;

    const lastService = await get(
      `SELECT completed_at
       FROM bookings
       WHERE user_id = ?
         AND vehicle_number = ?
         AND status = 'Completed'
       ORDER BY completed_at DESC
       LIMIT 1`,
      [userId, vehicle.vehicle_number]
    );
    const completedCountRow = await get(
      `SELECT COUNT(*) AS count
       FROM bookings
       WHERE user_id = ?
         AND vehicle_number = ?
         AND status = 'Completed'`,
      [userId, vehicle.vehicle_number]
    );
    const completedCount = Number(completedCountRow ? completedCountRow.count : 0);

    if (!lastService) {
      recs.push({
        priority: 'high',
        rule: 'baseline_first_service',
        text: 'No completed service history found. Run a full baseline inspection this week.'
      });
    } else {
      const lastMs = new Date(lastService.completed_at).getTime();
      const daysSince = Number.isNaN(lastMs) ? 0 : Math.floor((now - lastMs) / (24 * 60 * 60 * 1000));
      if (daysSince >= 180) {
        recs.push({
          priority: 'high',
          rule: 'service_gap_long',
          text: `Last service was ${daysSince} days ago. Schedule preventive service soon.`
        });
      } else if (daysSince >= 120) {
        recs.push({
          priority: 'medium',
          rule: 'service_gap_medium',
          text: `Last service was ${daysSince} days ago. A routine check is recommended.`
        });
      }
    }

    if (age >= 8) {
      recs.push({
        priority: 'high',
        rule: 'vehicle_age_high',
        text: `Vehicle is ${age} years old. Add suspension, brake line, and engine mount inspection.`
      });
    } else if (age >= 5) {
      recs.push({
        priority: 'medium',
        rule: 'vehicle_age_mid',
        text: `Vehicle is ${age} years old. Include battery/alternator health and fluid flush checks.`
      });
    }

    const month = new Date().getMonth() + 1;
    if (month >= 6 && month <= 9) {
      recs.push({
        priority: 'medium',
        rule: 'season_monsoon',
        text: 'Monsoon season: prioritize wiper blades, tire tread depth, and brake response checks.'
      });
    } else if (month >= 3 && month <= 5) {
      recs.push({
        priority: 'low',
        rule: 'season_summer',
        text: 'Summer season: run AC efficiency and coolant system inspection.'
      });
    }

    if (completedCount >= 6) {
      recs.push({
        priority: 'low',
        rule: 'high_usage_pattern',
        text: `High usage pattern (${completedCount} completed services). Consider annual maintenance package.`
      });
    }

    if (recs.length > 0) {
      result.push({
        vehicle: {
          id: vehicle.id,
          name: vehicle.name,
          number: vehicle.vehicle_number,
          brand: vehicle.brand,
          model: vehicle.model,
          year: Number(vehicle.year || 0)
        },
        recommendations: recs
      });
    }
  }

  return result;
}

function formatCurrencyInr(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function buildInvoicePdf(invoice, booking) {
  const doc = new PDFDocument({ margin: 48, size: 'A4' });
  const chunks = [];

  return new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#172033').text('CarSeva Invoice');
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor('#667085').text('Authorized Vehicle Service Invoice');
    doc.moveDown();

    doc.fontSize(12).fillColor('#172033');
    doc.text(`Invoice Number: ${invoice.invoiceId}`);
    doc.text(`Generated At: ${new Date(invoice.generatedAt).toLocaleString('en-IN')}`);
    if (booking && booking.bookingReference) {
      doc.text(`Booking Ref: ${booking.bookingReference}`);
    }
    doc.moveDown();

    doc.text(`Customer: ${invoice.userEmail}`);
    doc.text(`Vehicle: ${invoice.vehicleName}`);
    if (booking) {
      doc.text(`Plate: ${booking.vehicleNumber}`);
      doc.text(`Service Date: ${booking.date} (${booking.timeSlot})`);
      doc.text(`Center: ${booking.centerName || '-'}`);
    }
    doc.text(`Service Type: ${invoice.serviceType}`);
    doc.moveDown();

    doc.fontSize(13).fillColor('#172033').text('Cost Breakdown');
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor('#111827');
    doc.text(`Base Service Cost: ${formatCurrencyInr(invoice.cost)}`);
    doc.text(`GST (18%): ${formatCurrencyInr(invoice.tax)}`);
    doc.text(`Total: ${formatCurrencyInr(invoice.total)}`);
    doc.moveDown();

    doc.fontSize(10).fillColor('#667085').text('This is a digitally generated invoice from CarSeva.', {
      align: 'left'
    });

    doc.end();
  });
}

async function initializeDatabase() {
  await run('PRAGMA foreign_keys = ON');

  await run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    name TEXT NOT NULL,
    vehicle_number TEXT NOT NULL,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    year INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(vehicle_number)');
  await run('CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles(user_id)');

  await run(`CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    booking_reference TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    customer_name TEXT,
    vehicle_name TEXT NOT NULL,
    vehicle_number TEXT NOT NULL,
    service_type TEXT NOT NULL,
    service_category TEXT,
    service_price REAL NOT NULL,
    center_id TEXT,
    center_name TEXT,
    center_city TEXT,
    date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL,
    timeline_json TEXT NOT NULL,
    mechanic_notes TEXT,
    update_images_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    cancelled_at TEXT,
    cancelled_reason TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run('CREATE INDEX IF NOT EXISTS idx_bookings_user_status ON bookings(user_id, status)');
  await run('CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings(created_at)');
  await run('ALTER TABLE bookings ADD COLUMN vehicle_id TEXT').catch(() => {});

  await run(`CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    invoice_id TEXT UNIQUE NOT NULL,
    booking_id TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    vehicle_name TEXT NOT NULL,
    service_type TEXT NOT NULL,
    cost REAL NOT NULL,
    tax REAL NOT NULL,
    total REAL NOT NULL,
    generated_at TEXT NOT NULL,
    FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL,
    vehicle_number TEXT NOT NULL,
    document_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    data_base64 TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run('CREATE INDEX IF NOT EXISTS idx_documents_vehicle ON documents(vehicle_id)');
  await run('ALTER TABLE documents ADD COLUMN expiry_date TEXT').catch(() => {});

  await run(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    booking_id TEXT,
    booking_reference TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run('CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at)');

  await run(`CREATE TABLE IF NOT EXISTS service_updates (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    booking_reference TEXT,
    status TEXT NOT NULL,
    notes TEXT,
    image_data_url TEXT,
    image_name TEXT,
    mechanic_id TEXT NOT NULL,
    mechanic_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    FOREIGN KEY(mechanic_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  const seeds = [
    {
      id: 'seed_mechanic',
      email: 'mechanic@carseva.com',
      password: 'mechanic123',
      role: 'mechanic',
      name: 'CarSeva Mechanic'
    },
    {
      id: 'seed_admin',
      email: 'admin@carseva.com',
      password: 'admin123',
      role: 'admin',
      name: 'CarSeva Admin'
    },
    {
      id: 'seed_customer',
      email: 'customer@carseva.com',
      password: 'customer123',
      role: 'customer',
      name: 'CarSeva Customer'
    }
  ];

  for (const seed of seeds) {
    const exists = await get('SELECT id FROM users WHERE email = ?', [seed.email]);
    if (exists) {
      continue;
    }
    const hash = await bcrypt.hash(seed.password, 10);
    await run(
      'INSERT INTO users (id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [seed.id, seed.email, hash, seed.role, seed.name, nowIso()]
    );
  }
}

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(ROOT));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }
});

function readBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return '';
}

async function authRequired(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    const row = await get(
      `SELECT s.token, s.expires_at, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
      [token]
    );

    if (!row) {
      res.status(401).json({ error: 'Session not found. Please sign in again.' });
      return;
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await run('DELETE FROM sessions WHERE token = ?', [token]);
      res.status(401).json({ error: 'Session expired. Please sign in again.' });
      return;
    }

    req.authToken = token;
    req.user = publicUser(row);
    next();
  } catch (error) {
    next(error);
  }
}

function errorResponse(res, statusCode, message) {
  res.status(statusCode).json({ error: message });
}

app.get('/api/meta/service-catalog', (req, res) => {
  res.json(SERVICE_CATALOG);
});

app.get('/api/meta/status-stages', (req, res) => {
  res.json(STATUS_STAGES);
});

app.get('/api/meta/service-centers', (req, res) => {
  res.json(SERVICE_CENTERS);
});

app.post('/api/heuristics/quote', authRequired, async (req, res, next) => {
  try {
    const serviceId = String(req.body.serviceId || '').trim();
    const serviceType = String(req.body.serviceType || '').trim();
    const centerId = String(req.body.centerId || '').trim();
    const vehicleId = String(req.body.vehicleId || '').trim();
    const date = String(req.body.date || '').trim();
    const timeSlot = String(req.body.timeSlot || '').trim();

    const service = getServiceById(serviceId) || getServiceByName(serviceType);
    if (!service) {
      errorResponse(res, 400, 'Valid service is required for quote prediction.');
      return;
    }

    const center = getCenterById(centerId);
    const vehicle = vehicleId
      ? await get('SELECT * FROM vehicles WHERE id = ? AND user_id = ?', [vehicleId, req.user.id])
      : null;

    const quote = await buildHeuristicQuote({
      userId: req.user.id,
      service,
      center,
      vehicle,
      date,
      timeSlot
    });

    res.json({
      ...quote,
      serviceName: service.name,
      centerName: center ? center.name : ''
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/heuristics/maintenance', authRequired, async (req, res, next) => {
  try {
    const recommendations = await buildMaintenanceRecommendations(req.user.id);
    res.json(recommendations);
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const role = String(req.body.role || '').trim();

    const row = await get('SELECT * FROM users WHERE email = ?', [email]);
    if (!row) {
      errorResponse(res, 400, 'Invalid credentials.');
      return;
    }

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      errorResponse(res, 400, 'Invalid credentials.');
      return;
    }

    const user = publicUser(row);
    if (role === 'mechanic' && user.role !== 'mechanic' && user.role !== 'admin') {
      errorResponse(res, 400, 'Please use a mechanic account for this portal.');
      return;
    }
    if (role === 'customer' && user.role !== 'customer') {
      errorResponse(res, 400, 'Please use a customer account for this portal.');
      return;
    }

    const token = makeToken();
    await run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    await run(
      'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [token, user.id, nowIso(), new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString()]
    );

    res.json({ user, token });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!name) {
      errorResponse(res, 400, 'Please enter your name.');
      return;
    }
    if (!email || !/^([^\s@]+)@([^\s@]+)\.([^\s@]+)$/.test(email)) {
      errorResponse(res, 400, 'Please enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      errorResponse(res, 400, 'Password must be at least 6 characters.');
      return;
    }

    const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      errorResponse(res, 400, 'Email already registered.');
      return;
    }

    const userId = uid('user');
    const hash = await bcrypt.hash(password, 10);

    await run(
      'INSERT INTO users (id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, email, hash, 'customer', name, nowIso()]
    );

    const user = { id: userId, email, role: 'customer', name };
    const token = makeToken();

    await run(
      'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [token, userId, nowIso(), new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString()]
    );

    res.status(201).json({ user, token });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  res.json(req.user);
});

app.post('/api/auth/logout', authRequired, async (req, res, next) => {
  try {
    await run('DELETE FROM sessions WHERE token = ?', [req.authToken]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/bookings/active', authRequired, async (req, res, next) => {
  try {
    const rows = canMechanicAccess(req.user)
      ? await all("SELECT * FROM bookings WHERE status NOT IN ('Completed', 'Cancelled') ORDER BY created_at DESC")
      : await all("SELECT * FROM bookings WHERE user_id = ? AND status NOT IN ('Completed', 'Cancelled') ORDER BY created_at DESC", [req.user.id]);

    res.json(rows.map(mapBookingRow));
  } catch (error) {
    next(error);
  }
});

app.get('/api/bookings/completed', authRequired, async (req, res, next) => {
  try {
    const rows = canMechanicAccess(req.user)
      ? await all("SELECT * FROM bookings WHERE status = 'Completed' ORDER BY completed_at DESC")
      : await all("SELECT * FROM bookings WHERE user_id = ? AND status = 'Completed' ORDER BY completed_at DESC", [req.user.id]);

    const result = [];
    for (const row of rows) {
      const booking = mapBookingRow(row);
      booking.invoice = await getInvoiceByBookingId(booking.id);
      result.push(booking);
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/bookings', authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== 'customer') {
      errorResponse(res, 403, 'Only customers can create bookings.');
      return;
    }

    const vehicleId = String(req.body.vehicleId || '').trim();
    const serviceType = String(req.body.serviceType || '').trim();
    const centerId = String(req.body.centerId || '').trim();
    const date = String(req.body.date || '').trim();
    const timeSlot = String(req.body.timeSlot || '').trim();
    const notes = String(req.body.notes || '').trim();

    if (!vehicleId || !serviceType || !centerId || !date || !timeSlot) {
      errorResponse(res, 400, 'Please fill all required booking fields.');
      return;
    }

    const service = getServiceByName(serviceType);
    const center = getCenterById(centerId);
    if (!service || !center) {
      errorResponse(res, 400, 'Invalid service or center selection.');
      return;
    }

    const vehicle = await get('SELECT * FROM vehicles WHERE id = ? AND user_id = ?', [vehicleId, req.user.id]);
    if (!vehicle) {
      errorResponse(res, 400, 'Please select one of your registered vehicles.');
      return;
    }

    const vehicleName = String(vehicle.name || '').trim();
    const vehicleNumber = normalizePlate(vehicle.vehicle_number || '');

    if (!vehicleName || !isValidIndianPlate(vehicleNumber)) {
      errorResponse(res, 400, 'Selected vehicle has invalid details.');
      return;
    }

    const duplicateVehicleSameDay = await get(
      `SELECT id FROM bookings
       WHERE user_id = ?
         AND vehicle_number = ?
         AND date = ?
         AND status NOT IN ('Cancelled')
       LIMIT 1`,
      [req.user.id, vehicleNumber, date]
    );
    if (duplicateVehicleSameDay) {
      errorResponse(res, 400, 'This vehicle already has a booking on the selected date.');
      return;
    }

    const capacityOk = await hasSlotCapacity(center.id, date, timeSlot);
    if (!capacityOk) {
      errorResponse(res, 400, 'Selected slot is full for this center. Please choose another slot.');
      return;
    }

    const bookingReference = `CSV-${Date.now().toString().slice(-6)}`;
    const booking = {
      id: uid('booking'),
      bookingReference,
      userId: req.user.id,
      userEmail: req.user.email,
      customerName: req.user.name,
      vehicleId: vehicle.id,
      vehicleName,
      vehicleNumber,
      serviceType,
      serviceCategory: service.category,
      servicePrice: service.price,
      centerId: center.id,
      centerName: center.name,
      centerCity: center.city,
      date,
      timeSlot,
      notes,
      status: 'Received',
      timeline: makeTimeline('Received', 'Booking received and queued for service.'),
      mechanicNotes: '',
      updateImages: [],
      createdAt: nowIso(),
      completedAt: null
    };

    await run(
      `INSERT INTO bookings (
        id, booking_reference, user_id, user_email, customer_name, vehicle_id, vehicle_name, vehicle_number,
        service_type, service_category, service_price, center_id, center_name, center_city,
        date, time_slot, notes, status, timeline_json, mechanic_notes, update_images_json,
        created_at, completed_at, cancelled_at, cancelled_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        booking.id,
        booking.bookingReference,
        booking.userId,
        booking.userEmail,
        booking.customerName,
        booking.vehicleId,
        booking.vehicleName,
        booking.vehicleNumber,
        booking.serviceType,
        booking.serviceCategory,
        booking.servicePrice,
        booking.centerId,
        booking.centerName,
        booking.centerCity,
        booking.date,
        booking.timeSlot,
        booking.notes,
        booking.status,
        JSON.stringify(booking.timeline),
        booking.mechanicNotes,
        JSON.stringify(booking.updateImages),
        booking.createdAt,
        booking.completedAt,
        null,
        null
      ]
    );

    await addNotification({
      userId: req.user.id,
      type: 'booking-confirmed',
      title: 'Booking confirmed',
      message: `${booking.bookingReference} is scheduled at ${booking.centerName || 'your selected center'} on ${booking.date} during ${booking.timeSlot}.`,
      bookingId: booking.id,
      bookingReference: booking.bookingReference
    });

    res.status(201).json(booking);
  } catch (error) {
    next(error);
  }
});

app.post('/api/bookings/:id/status', authRequired, async (req, res, next) => {
  try {
    if (!canMechanicAccess(req.user)) {
      errorResponse(res, 403, 'Mechanic access required.');
      return;
    }

    const bookingId = String(req.params.id || '');
    const newStatus = String(req.body.status || '').trim();
    const note = String(req.body.notes || '').trim();
    const imageDataUrl = String(req.body.imageDataUrl || '').trim();
    const imageName = String(req.body.imageName || '').trim();

    if (!STATUS_STAGES.includes(newStatus)) {
      errorResponse(res, 400, 'Unsupported status update.');
      return;
    }

    const bookingRow = await get("SELECT * FROM bookings WHERE id = ? AND status NOT IN ('Completed', 'Cancelled')", [bookingId]);
    if (!bookingRow) {
      errorResponse(res, 404, 'Active booking not found.');
      return;
    }

    const booking = mapBookingRow(bookingRow);
    booking.status = newStatus;
    booking.mechanicNotes = note || booking.mechanicNotes;

    const createdAt = nowIso();
    booking.timeline = Array.isArray(booking.timeline) ? booking.timeline : makeTimeline(booking.status, `${booking.status} recorded`);
    booking.timeline.push({
      id: uid('timeline'),
      status: newStatus,
      note: note || `${newStatus} update added`,
      createdAt,
      actorName: req.user.name || req.user.email,
      imageName
    });

    booking.updateImages = Array.isArray(booking.updateImages) ? booking.updateImages : [];
    if (imageDataUrl) {
      booking.updateImages.push({
        id: uid('image'),
        fileName: imageName || 'service-image',
        dataUrl: imageDataUrl,
        uploadedAt: createdAt
      });
    }

    await run(
      `INSERT INTO service_updates (
        id, booking_id, booking_reference, status, notes, image_data_url, image_name,
        mechanic_id, mechanic_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uid('update'),
        booking.id,
        booking.bookingReference,
        newStatus,
        note,
        imageDataUrl || null,
        imageName || null,
        req.user.id,
        req.user.name || req.user.email,
        createdAt
      ]
    );

    if (newStatus !== 'Completed') {
      await run(
        `UPDATE bookings
         SET status = ?, timeline_json = ?, mechanic_notes = ?, update_images_json = ?
         WHERE id = ?`,
        [
          booking.status,
          JSON.stringify(booking.timeline),
          booking.mechanicNotes,
          JSON.stringify(booking.updateImages),
          booking.id
        ]
      );

      await addNotification({
        userId: booking.userId,
        type: 'service-update',
        title: `Service ${newStatus.toLowerCase()}`,
        message: `${booking.bookingReference || 'Your booking'} moved to ${newStatus}${note ? `: ${note}` : '.'}`,
        bookingId: booking.id,
        bookingReference: booking.bookingReference
      });

      res.json({ booking, invoice: null });
      return;
    }

    booking.completedAt = nowIso();
    await run(
      `UPDATE bookings
       SET status = 'Completed', timeline_json = ?, mechanic_notes = ?, update_images_json = ?, completed_at = ?
       WHERE id = ?`,
      [
        JSON.stringify(booking.timeline),
        booking.mechanicNotes,
        JSON.stringify(booking.updateImages),
        booking.completedAt,
        booking.id
      ]
    );

    let invoice = await getInvoiceByBookingId(booking.id);
    if (!invoice) {
      invoice = await buildInvoiceForBooking(booking);
    }

    await addNotification({
      userId: booking.userId,
      type: 'service-completed',
      title: 'Service completed',
      message: `${booking.bookingReference || 'Your booking'} is completed. Invoice ${invoice.invoiceId} is ready to download.${note ? ` Mechanic note: ${note}` : ''}`,
      bookingId: booking.id,
      bookingReference: booking.bookingReference
    });

    res.json({ booking, invoice });
  } catch (error) {
    next(error);
  }
});

app.post('/api/bookings/:id/cancel', authRequired, async (req, res, next) => {
  try {
    const bookingId = String(req.params.id || '');
    const reason = String(req.body.reason || '').trim();
    const bookingRow = await get("SELECT * FROM bookings WHERE id = ? AND status NOT IN ('Completed', 'Cancelled')", [bookingId]);

    if (!bookingRow) {
      errorResponse(res, 404, 'Active booking not found.');
      return;
    }

    const booking = mapBookingRow(bookingRow);
    if (!canMechanicAccess(req.user) && booking.userId !== req.user.id) {
      errorResponse(res, 403, 'You are not allowed to cancel this booking.');
      return;
    }

    if (!canMechanicAccess(req.user) && !['Received', 'Inspection'].includes(booking.status)) {
      errorResponse(res, 400, 'Booking can no longer be cancelled at this stage.');
      return;
    }
    if (!canMechanicAccess(req.user) && !canCustomerEditSlot(booking)) {
      errorResponse(res, 400, `Cancellation is only allowed at least ${CUSTOMER_CUTOFF_HOURS} hours before the slot.`);
      return;
    }

    booking.status = 'Cancelled';
    booking.timeline.push({
      id: uid('timeline'),
      status: 'Cancelled',
      note: reason || 'Booking cancelled',
      createdAt: nowIso(),
      actorName: req.user.name || req.user.email
    });

    await run(
      `UPDATE bookings
       SET status = 'Cancelled', timeline_json = ?, cancelled_at = ?, cancelled_reason = ?
       WHERE id = ?`,
      [JSON.stringify(booking.timeline), nowIso(), reason || null, booking.id]
    );

    await addNotification({
      userId: booking.userId,
      type: 'booking-cancelled',
      title: 'Booking cancelled',
      message: `${booking.bookingReference || 'Your booking'} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
      bookingId: booking.id,
      bookingReference: booking.bookingReference
    });

    res.json({ ok: true, booking });
  } catch (error) {
    next(error);
  }
});

app.post('/api/bookings/:id/reschedule', authRequired, async (req, res, next) => {
  try {
    const bookingId = String(req.params.id || '');
    const date = String(req.body.date || '').trim();
    const timeSlot = String(req.body.timeSlot || '').trim();
    const centerId = String(req.body.centerId || '').trim();
    const reason = String(req.body.reason || '').trim();
    const bookingRow = await get("SELECT * FROM bookings WHERE id = ? AND status NOT IN ('Completed', 'Cancelled')", [bookingId]);

    if (!bookingRow) {
      errorResponse(res, 404, 'Active booking not found.');
      return;
    }
    if (!date || !timeSlot || !centerId) {
      errorResponse(res, 400, 'Date, slot and center are required for reschedule.');
      return;
    }

    const booking = mapBookingRow(bookingRow);
    if (!canMechanicAccess(req.user) && booking.userId !== req.user.id) {
      errorResponse(res, 403, 'You are not allowed to reschedule this booking.');
      return;
    }

    if (!canMechanicAccess(req.user)) {
      if (!['Received', 'Inspection'].includes(booking.status)) {
        errorResponse(res, 400, 'Booking can no longer be rescheduled at this stage.');
        return;
      }
      if (!canCustomerEditSlot(booking)) {
        errorResponse(res, 400, `Reschedule is only allowed at least ${CUSTOMER_CUTOFF_HOURS} hours before the slot.`);
        return;
      }
    }

    const center = getCenterById(centerId);
    if (!center) {
      errorResponse(res, 400, 'Invalid center selected.');
      return;
    }

    const capacityOk = await hasSlotCapacity(center.id, date, timeSlot, booking.id);
    if (!capacityOk) {
      errorResponse(res, 400, 'Selected slot is full for this center. Please choose another slot.');
      return;
    }

    const duplicateVehicleSameDay = await get(
      `SELECT id FROM bookings
       WHERE user_id = ?
         AND vehicle_number = ?
         AND date = ?
         AND id != ?
         AND status NOT IN ('Cancelled')
       LIMIT 1`,
      [booking.userId, booking.vehicleNumber, date, booking.id]
    );
    if (duplicateVehicleSameDay) {
      errorResponse(res, 400, 'This vehicle already has another booking on the selected date.');
      return;
    }

    booking.date = date;
    booking.timeSlot = timeSlot;
    booking.centerId = center.id;
    booking.centerName = center.name;
    booking.centerCity = center.city;
    booking.timeline.push({
      id: uid('timeline'),
      status: booking.status,
      note: `Rescheduled to ${date} (${timeSlot}) at ${center.name}${reason ? `: ${reason}` : ''}`,
      createdAt: nowIso(),
      actorName: req.user.name || req.user.email
    });

    await run(
      `UPDATE bookings
       SET date = ?, time_slot = ?, center_id = ?, center_name = ?, center_city = ?, timeline_json = ?
       WHERE id = ?`,
      [booking.date, booking.timeSlot, booking.centerId, booking.centerName, booking.centerCity, JSON.stringify(booking.timeline), booking.id]
    );

    await addNotification({
      userId: booking.userId,
      type: 'booking-rescheduled',
      title: 'Booking rescheduled',
      message: `${booking.bookingReference || 'Your booking'} moved to ${booking.date} (${booking.timeSlot}) at ${booking.centerName}.${reason ? ` Reason: ${reason}` : ''}`,
      bookingId: booking.id,
      bookingReference: booking.bookingReference
    });

    res.json({ ok: true, booking });
  } catch (error) {
    next(error);
  }
});

app.get('/api/vehicles', authRequired, async (req, res, next) => {
  try {
    const rows = await all('SELECT * FROM vehicles WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json(rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      userEmail: row.user_email,
      name: row.name,
      vehicleNumber: row.vehicle_number,
      brand: row.brand,
      model: row.model,
      year: Number(row.year),
      createdAt: row.created_at
    })));
  } catch (error) {
    next(error);
  }
});

app.post('/api/vehicles', authRequired, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const vehicleNumber = normalizePlate(req.body.vehicleNumber);
    const brand = String(req.body.brand || '').trim();
    const model = String(req.body.model || '').trim();
    const year = Number(req.body.year);

    if (!name || !brand || !model || !Number.isFinite(year) || year < 1900 || year > 2099 || !isValidIndianPlate(vehicleNumber)) {
      errorResponse(res, 400, 'Invalid vehicle data.');
      return;
    }

    const existing = await get('SELECT * FROM vehicles WHERE vehicle_number = ?', [vehicleNumber]);
    if (existing && existing.user_id !== req.user.id) {
      errorResponse(res, 400, 'This vehicle number is already registered by another user.');
      return;
    }
    if (existing && existing.user_id === req.user.id) {
      errorResponse(res, 400, 'You already have this vehicle registered.');
      return;
    }

    const vehicle = {
      id: uid('vehicle'),
      userId: req.user.id,
      userEmail: req.user.email,
      name,
      vehicleNumber,
      brand,
      model,
      year,
      createdAt: nowIso()
    };

    await run(
      `INSERT INTO vehicles (id, user_id, user_email, name, vehicle_number, brand, model, year, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [vehicle.id, vehicle.userId, vehicle.userEmail, vehicle.name, vehicle.vehicleNumber, vehicle.brand, vehicle.model, vehicle.year, vehicle.createdAt]
    );

    res.status(201).json(vehicle);
  } catch (error) {
    next(error);
  }
});

app.put('/api/vehicles/:id', authRequired, async (req, res, next) => {
  try {
    const vehicleId = String(req.params.id || '');
    const current = await get('SELECT * FROM vehicles WHERE id = ? AND user_id = ?', [vehicleId, req.user.id]);
    if (!current) {
      errorResponse(res, 404, 'Vehicle not found.');
      return;
    }

    const name = String(req.body.name || '').trim();
    const vehicleNumber = normalizePlate(req.body.vehicleNumber);
    const brand = String(req.body.brand || '').trim();
    const model = String(req.body.model || '').trim();
    const year = Number(req.body.year);

    if (!name || !brand || !model || !Number.isFinite(year) || year < 1900 || year > 2099 || !isValidIndianPlate(vehicleNumber)) {
      errorResponse(res, 400, 'Invalid vehicle data.');
      return;
    }

    const duplicate = await get('SELECT * FROM vehicles WHERE vehicle_number = ? AND id != ?', [vehicleNumber, vehicleId]);
    if (duplicate && duplicate.user_id !== req.user.id) {
      errorResponse(res, 400, 'This vehicle number is already registered by another user.');
      return;
    }
    if (duplicate && duplicate.user_id === req.user.id) {
      errorResponse(res, 400, 'You already have this vehicle registered.');
      return;
    }

    await run(
      'UPDATE vehicles SET name = ?, vehicle_number = ?, brand = ?, model = ?, year = ? WHERE id = ? AND user_id = ?',
      [name, vehicleNumber, brand, model, year, vehicleId, req.user.id]
    );

    res.json({
      id: vehicleId,
      userId: req.user.id,
      userEmail: req.user.email,
      name,
      vehicleNumber,
      brand,
      model,
      year,
      createdAt: current.created_at
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/vehicles/:id', authRequired, async (req, res, next) => {
  try {
    const vehicleId = String(req.params.id || '');
    const current = await get('SELECT * FROM vehicles WHERE id = ? AND user_id = ?', [vehicleId, req.user.id]);
    if (!current) {
      errorResponse(res, 404, 'Vehicle not found.');
      return;
    }

    await run('DELETE FROM documents WHERE vehicle_id = ?', [vehicleId]);
    await run('DELETE FROM vehicles WHERE id = ? AND user_id = ?', [vehicleId, req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents', authRequired, async (req, res, next) => {
  try {
    const vehicleId = String(req.query.vehicleId || '').trim();
    const vehicleNumber = normalizePlate(req.query.vehicleNumber || '');

    let rows = [];
    if (canMechanicAccess(req.user)) {
      if (vehicleId) {
        rows = await all('SELECT * FROM documents WHERE vehicle_id = ? ORDER BY uploaded_at DESC', [vehicleId]);
      } else if (vehicleNumber) {
        rows = await all('SELECT * FROM documents WHERE vehicle_number = ? ORDER BY uploaded_at DESC', [vehicleNumber]);
      }
    } else {
      rows = await all(
        'SELECT * FROM documents WHERE user_id = ? AND vehicle_id = ? ORDER BY uploaded_at DESC',
        [req.user.id, vehicleId]
      );
    }

    res.json(rows.map((row) => ({
      id: row.id,
      documentType: row.document_type,
      fileName: row.file_name,
      uploadedAt: row.uploaded_at,
      expiryDate: row.expiry_date || null,
      mimeType: row.mime_type,
      dataUrl: row.data_base64
    })));
  } catch (error) {
    next(error);
  }
});

app.post('/api/documents', authRequired, upload.single('file'), async (req, res, next) => {
  try {
    if (canMechanicAccess(req.user)) {
      errorResponse(res, 403, 'Mechanic view is read-only for documents.');
      return;
    }

    const vehicleId = String(req.body.vehicleId || '').trim();
    const documentType = String(req.body.documentType || '').trim();
    const expiryDate = String(req.body.expiryDate || '').trim();

    if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      errorResponse(res, 400, 'Expiry date must be in YYYY-MM-DD format.');
      return;
    }

    if (!vehicleId || !documentType || !req.file) {
      errorResponse(res, 400, 'Vehicle, type and file are required.');
      return;
    }

    const vehicle = await get('SELECT * FROM vehicles WHERE id = ? AND user_id = ?', [vehicleId, req.user.id]);
    if (!vehicle) {
      errorResponse(res, 403, 'Access denied to this vehicle.');
      return;
    }

    const allowedTypes = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]);

    if (!allowedTypes.has(req.file.mimetype)) {
      errorResponse(res, 400, 'File type not supported. Allow: PDF, JPG, PNG, DOC, DOCX');
      return;
    }

    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const document = {
      id: uid('document'),
      userId: req.user.id,
      vehicleId,
      vehicleNumber: vehicle.vehicle_number,
      documentType,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      dataUrl,
      expiryDate: expiryDate || null,
      uploadedAt: nowIso()
    };

    await run(
      `INSERT INTO documents (
        id, user_id, vehicle_id, vehicle_number, document_type, file_name, mime_type, file_size, data_base64, expiry_date, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        document.id,
        document.userId,
        document.vehicleId,
        document.vehicleNumber,
        document.documentType,
        document.fileName,
        document.mimeType,
        document.fileSize,
        document.dataUrl,
        document.expiryDate,
        document.uploadedAt
      ]
    );

    if (document.expiryDate) {
      const expiryMs = new Date(`${document.expiryDate}T00:00:00`).getTime();
      const thresholdMs = Date.now() + (30 * 24 * 60 * 60 * 1000);
      if (!Number.isNaN(expiryMs) && expiryMs <= thresholdMs) {
        await addNotification({
          userId: req.user.id,
          type: 'document-expiry',
          title: 'Document expiry reminder',
          message: `${document.documentType} for ${document.vehicleNumber} expires on ${document.expiryDate}.`,
          bookingId: null,
          bookingReference: null
        });
      }
    }

    res.status(201).json(document);
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents-expiring', authRequired, async (req, res, next) => {
  try {
    const withinDays = Math.max(1, Math.min(120, Number(req.query.withinDays || 30)));
    const today = new Date();
    const end = new Date(today.getTime() + (withinDays * 24 * 60 * 60 * 1000));
    const startDate = today.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    const rows = await all(
      `SELECT * FROM documents
       WHERE user_id = ?
         AND expiry_date IS NOT NULL
         AND expiry_date != ''
         AND expiry_date >= ?
         AND expiry_date <= ?
       ORDER BY expiry_date ASC`,
      [req.user.id, startDate, endDate]
    );

    res.json(rows.map((row) => ({
      id: row.id,
      vehicleId: row.vehicle_id,
      vehicleNumber: row.vehicle_number,
      documentType: row.document_type,
      fileName: row.file_name,
      expiryDate: row.expiry_date,
      uploadedAt: row.uploaded_at
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id', authRequired, async (req, res, next) => {
  try {
    const docId = String(req.params.id || '');
    const row = await get('SELECT * FROM documents WHERE id = ?', [docId]);
    if (!row) {
      errorResponse(res, 404, 'Document not found.');
      return;
    }

    if (!canMechanicAccess(req.user) && row.user_id !== req.user.id) {
      errorResponse(res, 403, 'Document not found.');
      return;
    }

    res.json({
      id: row.id,
      userId: row.user_id,
      vehicleId: row.vehicle_id,
      vehicleNumber: row.vehicle_number,
      documentType: row.document_type,
      fileName: row.file_name,
      mimeType: row.mime_type,
      fileSize: Number(row.file_size || 0),
      dataUrl: row.data_base64,
      expiryDate: row.expiry_date || null,
      uploadedAt: row.uploaded_at
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/documents/:id', authRequired, async (req, res, next) => {
  try {
    const docId = String(req.params.id || '');
    const row = await get('SELECT * FROM documents WHERE id = ?', [docId]);
    if (!row || row.user_id !== req.user.id) {
      errorResponse(res, 404, 'Document not found.');
      return;
    }

    await run('DELETE FROM documents WHERE id = ?', [docId]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/invoices/:bookingId/pdf', authRequired, async (req, res, next) => {
  try {
    const bookingId = String(req.params.bookingId || '');
    const bookingRow = await get("SELECT * FROM bookings WHERE id = ? AND status = 'Completed'", [bookingId]);
    if (!bookingRow) {
      errorResponse(res, 404, 'Completed booking not found.');
      return;
    }

    if (!canMechanicAccess(req.user) && bookingRow.user_id !== req.user.id) {
      errorResponse(res, 403, 'Invoice not found.');
      return;
    }

    const invoice = await getInvoiceByBookingId(bookingId);
    if (!invoice) {
      errorResponse(res, 404, 'Invoice not available.');
      return;
    }

    const booking = mapBookingRow(bookingRow);
    const pdf = await buildInvoicePdf(invoice, booking);
    const filename = `invoice-${invoice.invoiceId}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=\"${filename}\"`);
    res.send(pdf);
  } catch (error) {
    next(error);
  }
});

app.get('/api/history', authRequired, async (req, res, next) => {
  try {
    const bookings = canMechanicAccess(req.user)
      ? await all("SELECT * FROM bookings WHERE status = 'Completed' ORDER BY completed_at DESC")
      : await all("SELECT * FROM bookings WHERE user_id = ? AND status = 'Completed' ORDER BY completed_at DESC", [req.user.id]);

    const result = [];
    for (const row of bookings) {
      const booking = mapBookingRow(row);
      const invoice = await getInvoiceByBookingId(booking.id);
      result.push({
        id: booking.id,
        vehicleName: booking.vehicleName,
        vehicleNumber: booking.vehicleNumber,
        serviceType: booking.serviceType,
        completedAt: booking.completedAt,
        cost: invoice ? invoice.cost : 0,
        status: booking.status,
        invoice: invoice
          ? {
              invoiceId: invoice.invoiceId,
              total: invoice.total,
              generatedAt: invoice.generatedAt
            }
          : null
      });
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/notifications', authRequired, async (req, res, next) => {
  try {
    const rows = await all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json(rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      type: row.type,
      title: row.title,
      message: row.message,
      createdAt: row.created_at,
      read: Boolean(row.read),
      bookingId: row.booking_id || null,
      bookingReference: row.booking_reference || null
    })));
  } catch (error) {
    next(error);
  }
});

app.post('/api/notifications/read-all', authRequired, async (req, res, next) => {
  try {
    await run('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0', [req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/service-updates/:bookingId', authRequired, async (req, res, next) => {
  try {
    const bookingId = String(req.params.bookingId || '');
    const bookingRow = await get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!bookingRow) {
      errorResponse(res, 404, 'Booking not found.');
      return;
    }

    if (!canMechanicAccess(req.user) && bookingRow.user_id !== req.user.id) {
      errorResponse(res, 403, 'Booking not found.');
      return;
    }

    const rows = await all('SELECT * FROM service_updates WHERE booking_id = ? ORDER BY created_at DESC', [bookingId]);
    res.json(rows.map((row) => ({
      id: row.id,
      bookingId: row.booking_id,
      bookingReference: row.booking_reference,
      status: row.status,
      notes: row.notes || '',
      imageDataUrl: row.image_data_url || '',
      imageName: row.image_name || '',
      mechanicId: row.mechanic_id,
      mechanicName: row.mechanic_name,
      createdAt: row.created_at
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/stats', authRequired, async (req, res, next) => {
  try {
    const vehicleCountRow = await get('SELECT COUNT(*) AS count FROM vehicles WHERE user_id = ?', [req.user.id]);
    const unreadCountRow = await get('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read = 0', [req.user.id]);
    const expiringDocsCountRow = await get(
      `SELECT COUNT(*) AS count
       FROM documents
       WHERE user_id = ?
         AND expiry_date IS NOT NULL
         AND expiry_date != ''
         AND expiry_date >= date('now')
         AND expiry_date <= date('now', '+30 day')`,
      [req.user.id]
    );

    const activeCountRow = canMechanicAccess(req.user)
      ? await get("SELECT COUNT(*) AS count FROM bookings WHERE status NOT IN ('Completed', 'Cancelled')")
      : await get("SELECT COUNT(*) AS count FROM bookings WHERE user_id = ? AND status NOT IN ('Completed', 'Cancelled')", [req.user.id]);

    const completedCountRow = canMechanicAccess(req.user)
      ? await get("SELECT COUNT(*) AS count FROM bookings WHERE status = 'Completed'")
      : await get("SELECT COUNT(*) AS count FROM bookings WHERE user_id = ? AND status = 'Completed'", [req.user.id]);

    const customerSpendRow = await get(
      `SELECT COALESCE(SUM(i.total), 0) AS total
       FROM invoices i
       JOIN bookings b ON b.id = i.booking_id
       WHERE b.user_id = ?`,
      [req.user.id]
    );

    const todayPrefix = `${new Date().toISOString().slice(0, 10)}%`;
    const revenueTodayRow = canMechanicAccess(req.user)
      ? await get('SELECT COALESCE(SUM(total), 0) AS total FROM invoices WHERE generated_at LIKE ?', [todayPrefix])
      : { total: 0 };

    const overdueRow = canMechanicAccess(req.user)
      ? await get("SELECT COUNT(*) AS count FROM bookings WHERE status NOT IN ('Completed', 'Cancelled') AND date < date('now')")
      : { count: 0 };

    res.json({
      activeBookings: Number(activeCountRow ? activeCountRow.count : 0),
      completedBookings: Number(completedCountRow ? completedCountRow.count : 0),
      vehicles: Number(vehicleCountRow ? vehicleCountRow.count : 0),
      unreadNotifications: Number(unreadCountRow ? unreadCountRow.count : 0),
      expiringDocuments: Number(expiringDocsCountRow ? expiringDocsCountRow.count : 0),
      totalSpent: Number(customerSpendRow ? customerSpendRow.total : 0),
      revenueToday: Number(revenueTodayRow ? revenueTodayRow.total : 0),
      overdueBookings: Number(overdueRow ? overdueRow.count : 0)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/health', async (req, res) => {
  let dbReady = false;
  try {
    await get('SELECT 1 AS ok');
    dbReady = true;
  } catch (error) {
    dbReady = false;
  }

  res.json({
    ok: true,
    mode: 'sqlite',
    dbReady
  });
});

app.use((req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('API error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CarSeva server running on http://localhost:${PORT}`);
      console.log(`SQLite DB: ${DB_PATH}`);
      console.log('Seed users: customer@carseva.com / customer123, mechanic@carseva.com / mechanic123');
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });
