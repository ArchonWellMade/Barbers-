require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

const DATA_DIR = path.join(__dirname, 'data');
const SERVICES_FILE = path.join(DATA_DIR, 'services.json');
const BARBERS_FILE = path.join(DATA_DIR, 'barbers.json');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const NEWSLETTER_FILE = path.join(DATA_DIR, 'newsletter.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const GIFTCARDS_FILE = path.join(DATA_DIR, 'giftcards.json');

// ---------- tiny JSON "database" helpers with a write queue (avoids concurrent corruption) ----------
function ensureFile(file, initial) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(initial, null, 2));
  }
}
ensureFile(BOOKINGS_FILE, []);
ensureFile(CONTACTS_FILE, []);
ensureFile(NEWSLETTER_FILE, []);
ensureFile(REVIEWS_FILE, []);
ensureFile(GIFTCARDS_FILE, []);

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const writeQueues = new Map();
function writeJSON(file, data) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => fs.promises.writeFile(file, JSON.stringify(data, null, 2)));
  writeQueues.set(file, next);
  return next;
}

// ---------- app setup ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.redirect('/admin.html');
});
app.get('/admin/', (req, res) => {
  res.redirect('/admin.html');
});

// ---------- business rules ----------
const SLOT_MINUTES = 30;
const CLOSED_DAYS = []; // none globally closed; per-barber workDays controls availability

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function toHHMM(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function getBarber(barberId) {
  return readJSON(BARBERS_FILE).find((b) => b.id === barberId);
}
function getService(serviceId) {
  return readJSON(SERVICES_FILE).find((s) => s.id === serviceId);
}

function isPastDateTime(dateStr, timeStr) {
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  return dt.getTime() < Date.now();
}

function computeAvailableSlots({ barberId, date, serviceId, excludeBookingId }) {
  const barber = getBarber(barberId);
  const service = getService(serviceId);
  if (!barber || !service) return { error: 'Invalid barber or service', slots: [] };

  const dateObj = new Date(`${date}T00:00:00`);
  const dayOfWeek = dateObj.getDay();
  if (!barber.workDays.includes(dayOfWeek)) {
    return { error: null, slots: [] };
  }

  const startMin = barber.startHour * 60;
  const endMin = barber.endHour * 60;
  const duration = service.duration;

  const bookings = readJSON(BOOKINGS_FILE).filter(
    (b) => b.barberId === barberId && b.date === date && b.status !== 'cancelled' && b.id !== excludeBookingId
  );

  const busyRanges = bookings.map((b) => {
    const bStart = toMinutes(b.time);
    const bDuration = getService(b.serviceId)?.duration || 30;
    return [bStart, bStart + bDuration];
  });

  const slots = [];
  for (let t = startMin; t + duration <= endMin; t += SLOT_MINUTES) {
    const slotEnd = t + duration;
    const overlaps = busyRanges.some(([s, e]) => t < e && slotEnd > s);
    if (overlaps) continue;
    const hhmm = toHHMM(t);
    if (isPastDateTime(date, hhmm)) continue;
    slots.push(hhmm);
  }

  return { error: null, slots };
}

// ---------- loyalty program ----------
const LOYALTY_TIERS = [
  { name: 'Bronze', minVisits: 0, discountPercent: 0 },
  { name: 'Silver', minVisits: 3, discountPercent: 10 },
  { name: 'Gold', minVisits: 6, discountPercent: 15 },
  { name: 'Platinum', minVisits: 10, discountPercent: 20 },
];

function computeLoyalty(email) {
  if (!email) return { email: null, visits: 0, tier: LOYALTY_TIERS[0].name, discountPercent: 0, nextTier: LOYALTY_TIERS[1], visitsToNextTier: LOYALTY_TIERS[1].minVisits };
  const normalized = String(email).toLowerCase();
  const visits = readJSON(BOOKINGS_FILE).filter(
    (b) => b.email.toLowerCase() === normalized && b.status !== 'cancelled'
  ).length;

  let tier = LOYALTY_TIERS[0];
  for (const t of LOYALTY_TIERS) {
    if (visits >= t.minVisits) tier = t;
  }
  const tierIndex = LOYALTY_TIERS.indexOf(tier);
  const nextTier = LOYALTY_TIERS[tierIndex + 1] || null;

  return {
    email: normalized,
    visits,
    tier: tier.name,
    discountPercent: tier.discountPercent,
    nextTier: nextTier ? nextTier.name : null,
    visitsToNextTier: nextTier ? nextTier.minVisits - visits : 0,
  };
}

// ---------- gift cards ----------
function generateGiftCardCode() {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `EC-${part()}-${part()}`;
}

function getGiftCard(code) {
  if (!code) return null;
  const normalized = String(code).trim().toUpperCase();
  return readJSON(GIFTCARDS_FILE).find((g) => g.code === normalized) || null;
}

// ---------- auth middleware ----------
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// =====================================================================
// PUBLIC API
// =====================================================================

app.get('/api/services', (req, res) => {
  res.json(readJSON(SERVICES_FILE));
});

app.get('/api/barbers', (req, res) => {
  res.json(readJSON(BARBERS_FILE));
});

app.get('/api/availability', (req, res) => {
  const { barberId, date, serviceId } = req.query;
  if (!barberId || !date || !serviceId) {
    return res.status(400).json({ error: 'barberId, date and serviceId are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format, expected YYYY-MM-DD' });
  }
  const { error, slots } = computeAvailableSlots({ barberId, date, serviceId });
  if (error) return res.status(400).json({ error });
  res.json({ date, barberId, serviceId, slots });
});

app.get('/api/loyalty', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email is required' });
  res.json(computeLoyalty(email));
});

app.get('/api/gift-cards/:code', (req, res) => {
  const card = getGiftCard(req.params.code);
  if (!card) return res.status(404).json({ error: 'Gift card not found' });
  res.json({ code: card.code, balance: card.balance, initialAmount: card.initialAmount, active: card.balance > 0 });
});

app.post('/api/gift-cards', async (req, res) => {
  const { amount, senderName, senderEmail, recipientName, recipientEmail, message } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt < 10 || amt > 1000) {
    return res.status(400).json({ error: 'Amount must be between $10 and $1000' });
  }
  if (!senderName || !senderEmail || !recipientName) {
    return res.status(400).json({ error: 'Sender name, sender email and recipient name are required' });
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(senderEmail)) {
    return res.status(400).json({ error: 'Invalid sender email' });
  }

  const cards = readJSON(GIFTCARDS_FILE);
  let code = generateGiftCardCode();
  while (cards.some((c) => c.code === code)) code = generateGiftCardCode();

  const card = {
    code,
    initialAmount: amt,
    balance: amt,
    senderName: String(senderName).trim(),
    senderEmail: String(senderEmail).trim(),
    recipientName: String(recipientName).trim(),
    recipientEmail: recipientEmail ? String(recipientEmail).trim() : '',
    message: message ? String(message).trim().slice(0, 300) : '',
    redemptions: [],
    createdAt: new Date().toISOString(),
  };
  cards.push(card);
  await writeJSON(GIFTCARDS_FILE, cards);
  res.status(201).json({ giftCard: card });
});

app.get('/api/stats/public', (req, res) => {
  const bookings = readJSON(BOOKINGS_FILE);
  const today = new Date().toISOString().slice(0, 10);
  const bookedToday = bookings.filter((b) => b.date === today && b.status !== 'cancelled').length;
  const bookedThisWeek = bookings.filter((b) => {
    if (b.status === 'cancelled') return false;
    const d = new Date(`${b.createdAt}`);
    const diffDays = (Date.now() - d.getTime()) / 86400000;
    return diffDays <= 7;
  }).length;
  res.json({ bookedToday, bookedThisWeek });
});

app.post('/api/bookings', async (req, res) => {
  const { serviceId, barberId, date, time, name, email, phone, notes, giftCardCode } = req.body || {};

  if (!serviceId || !barberId || !date || !time || !name || !email || !phone) {
    return res.status(400).json({ error: 'Missing required booking fields' });
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  const service = getService(serviceId);
  const barber = getBarber(barberId);
  if (!service) return res.status(400).json({ error: 'Unknown service' });
  if (!barber) return res.status(400).json({ error: 'Unknown barber' });
  if (isPastDateTime(date, time)) {
    return res.status(400).json({ error: 'Cannot book a time in the past' });
  }

  // re-validate slot is still free (race-condition guard)
  const { slots } = computeAvailableSlots({ barberId, date, serviceId });
  if (!slots.includes(time)) {
    return res.status(409).json({ error: 'That time slot is no longer available. Please pick another.' });
  }

  // gift card validation (balance is deducted only after the booking is safely persisted)
  let giftCard = null;
  if (giftCardCode) {
    giftCard = getGiftCard(giftCardCode);
    if (!giftCard) return res.status(400).json({ error: 'Gift card not found' });
    if (giftCard.balance <= 0) return res.status(400).json({ error: 'Gift card has no remaining balance' });
  }

  const loyalty = computeLoyalty(email);
  const basePrice = service.price;
  const loyaltyDiscount = Math.round(basePrice * (loyalty.discountPercent / 100) * 100) / 100;
  const priceAfterLoyalty = Math.round((basePrice - loyaltyDiscount) * 100) / 100;
  const giftCardDiscount = giftCard ? Math.min(giftCard.balance, priceAfterLoyalty) : 0;
  const finalPrice = Math.round((priceAfterLoyalty - giftCardDiscount) * 100) / 100;

  const booking = {
    id: crypto.randomUUID(),
    serviceId,
    serviceName: service.name,
    basePrice,
    loyaltyDiscount,
    loyaltyTier: loyalty.tier,
    giftCardCode: giftCard ? giftCard.code : null,
    giftCardDiscount,
    price: finalPrice,
    duration: service.duration,
    barberId,
    barberName: barber.name,
    date,
    time,
    name: String(name).trim(),
    email: String(email).trim(),
    phone: String(phone).trim(),
    notes: notes ? String(notes).trim().slice(0, 500) : '',
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  };

  const bookings = readJSON(BOOKINGS_FILE);
  // final overlap safety-check right before write
  const conflict = bookings.some((b) => {
    if (b.barberId !== barberId || b.date !== date || b.status === 'cancelled') return false;
    const bStart = toMinutes(b.time);
    const bEnd = bStart + b.duration;
    const nStart = toMinutes(time);
    const nEnd = nStart + service.duration;
    return nStart < bEnd && nEnd > bStart;
  });
  if (conflict) {
    return res.status(409).json({ error: 'That time slot was just booked. Please pick another.' });
  }

  bookings.push(booking);
  await writeJSON(BOOKINGS_FILE, bookings);

  if (giftCard && giftCardDiscount > 0) {
    const cards = readJSON(GIFTCARDS_FILE);
    const cardRecord = cards.find((c) => c.code === giftCard.code);
    if (cardRecord) {
      cardRecord.balance = Math.round((cardRecord.balance - giftCardDiscount) * 100) / 100;
      cardRecord.redemptions.push({ bookingId: booking.id, amount: giftCardDiscount, date: new Date().toISOString() });
      await writeJSON(GIFTCARDS_FILE, cards);
    }
  }

  res.status(201).json({ booking });
});

// lookup a booking (for "manage my booking" by id + email)
app.get('/api/bookings/:id', (req, res) => {
  const { email } = req.query;
  const booking = readJSON(BOOKINGS_FILE).find((b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (email && booking.email.toLowerCase() !== String(email).toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match booking' });
  }
  res.json({ booking });
});

app.post('/api/bookings/:id/cancel', async (req, res) => {
  const { email } = req.body || {};
  const bookings = readJSON(BOOKINGS_FILE);
  const booking = bookings.find((b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!email || booking.email.toLowerCase() !== String(email).toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match booking' });
  }
  booking.status = 'cancelled';
  await writeJSON(BOOKINGS_FILE, bookings);
  res.json({ booking });
});

app.post('/api/bookings/:id/reschedule', async (req, res) => {
  const { email, date, time } = req.body || {};
  if (!email || !date || !time) {
    return res.status(400).json({ error: 'email, date and time are required' });
  }
  const bookings = readJSON(BOOKINGS_FILE);
  const booking = bookings.find((b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.email.toLowerCase() !== String(email).toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match booking' });
  }
  if (booking.status === 'cancelled') {
    return res.status(400).json({ error: 'This booking has been cancelled and cannot be rescheduled' });
  }
  if (isPastDateTime(date, time)) {
    return res.status(400).json({ error: 'Cannot reschedule to a time in the past' });
  }

  const { error, slots } = computeAvailableSlots({
    barberId: booking.barberId,
    date,
    serviceId: booking.serviceId,
    excludeBookingId: booking.id,
  });
  if (error) return res.status(400).json({ error });
  if (!slots.includes(time)) {
    return res.status(409).json({ error: 'That time slot is not available. Please pick another.' });
  }

  booking.date = date;
  booking.time = time;
  booking.rescheduledAt = new Date().toISOString();
  await writeJSON(BOOKINGS_FILE, bookings);
  res.json({ booking });
});

app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required' });
  }
  const contacts = readJSON(CONTACTS_FILE);
  contacts.push({
    id: crypto.randomUUID(),
    name: String(name).trim(),
    email: String(email).trim(),
    message: String(message).trim().slice(0, 2000),
    createdAt: new Date().toISOString(),
  });
  await writeJSON(CONTACTS_FILE, contacts);
  res.status(201).json({ ok: true });
});

app.post('/api/newsletter', async (req, res) => {
  const { email } = req.body || {};
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRe.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const list = readJSON(NEWSLETTER_FILE);
  if (!list.some((e) => e.email.toLowerCase() === email.toLowerCase())) {
    list.push({ email: String(email).trim(), createdAt: new Date().toISOString() });
    await writeJSON(NEWSLETTER_FILE, list);
  }
  res.status(201).json({ ok: true });
});

app.get('/api/reviews', (req, res) => {
  const reviews = readJSON(REVIEWS_FILE)
    .filter((r) => r.status === 'approved')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(({ email, ...rest }) => rest);
  res.json(reviews);
});

app.post('/api/reviews', async (req, res) => {
  const { name, email, rating, text, serviceId } = req.body || {};
  const r = Number(rating);
  if (!name || !email || !text || !r) {
    return res.status(400).json({ error: 'Name, email, rating and review text are required' });
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (r < 1 || r > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }
  const reviews = readJSON(REVIEWS_FILE);
  const review = {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    email: String(email).trim(),
    rating: Math.round(r),
    text: String(text).trim().slice(0, 1000),
    serviceId: serviceId || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  reviews.push(review);
  await writeJSON(REVIEWS_FILE, reviews);
  res.status(201).json({ review: { ...review, email: undefined } });
});

// =====================================================================
// ADMIN API
// =====================================================================

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const bookings = readJSON(BOOKINGS_FILE).sort((a, b) =>
    `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)
  );
  res.json(bookings);
});

app.patch('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['confirmed', 'completed', 'cancelled', 'no-show'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const bookings = readJSON(BOOKINGS_FILE);
  const booking = bookings.find((b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  booking.status = status;
  await writeJSON(BOOKINGS_FILE, bookings);
  res.json({ booking });
});

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  const bookings = readJSON(BOOKINGS_FILE);
  const idx = bookings.findIndex((b) => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Booking not found' });
  const [removed] = bookings.splice(idx, 1);
  await writeJSON(BOOKINGS_FILE, bookings);
  res.json({ booking: removed });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const bookings = readJSON(BOOKINGS_FILE);
  const today = new Date().toISOString().slice(0, 10);
  const revenue = bookings
    .filter((b) => b.status !== 'cancelled')
    .reduce((sum, b) => sum + (b.price || 0), 0);
  res.json({
    total: bookings.length,
    today: bookings.filter((b) => b.date === today && b.status !== 'cancelled').length,
    upcoming: bookings.filter((b) => b.date >= today && b.status === 'confirmed').length,
    cancelled: bookings.filter((b) => b.status === 'cancelled').length,
    revenue,
  });
});

app.get('/api/admin/contacts', requireAdmin, (req, res) => {
  res.json(readJSON(CONTACTS_FILE).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.get('/api/admin/bookings/export', requireAdmin, (req, res) => {
  const bookings = readJSON(BOOKINGS_FILE).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const headers = ['ID', 'Name', 'Email', 'Phone', 'Service', 'Barber', 'Date', 'Time', 'Price', 'Status', 'Created At'];
  const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
  const rows = bookings.map((b) => [
    b.id, b.name, b.email, b.phone, b.serviceName, b.barberName, b.date, b.time, b.price, b.status, b.createdAt,
  ].map(escapeCsv).join(','));
  const csv = [headers.map(escapeCsv).join(','), ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="bookings-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const bookings = readJSON(BOOKINGS_FILE).filter((b) => b.status !== 'cancelled');
  const services = readJSON(SERVICES_FILE);
  const barbers = readJSON(BARBERS_FILE);
  const reviews = readJSON(REVIEWS_FILE).filter((r) => r.status === 'approved');

  const serviceCounts = {};
  const barberCounts = {};
  bookings.forEach((b) => {
    serviceCounts[b.serviceId] = serviceCounts[b.serviceId] || { count: 0, revenue: 0 };
    serviceCounts[b.serviceId].count += 1;
    serviceCounts[b.serviceId].revenue += b.price || 0;
    barberCounts[b.barberId] = (barberCounts[b.barberId] || 0) + 1;
  });

  const popularServices = Object.entries(serviceCounts)
    .map(([serviceId, v]) => ({
      serviceId,
      name: services.find((s) => s.id === serviceId)?.name || serviceId,
      count: v.count,
      revenue: Math.round(v.revenue * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count);

  const topBarbers = Object.entries(barberCounts)
    .map(([barberId, count]) => ({ barberId, name: barbers.find((b) => b.id === barberId)?.name || barberId, count }))
    .sort((a, b) => b.count - a.count);

  const revenueByDay = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const revenue = bookings.filter((b) => b.date === dateStr).reduce((sum, b) => sum + (b.price || 0), 0);
    revenueByDay.push({ date: dateStr, revenue: Math.round(revenue * 100) / 100 });
  }

  const avgRating = reviews.length
    ? Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10) / 10
    : 0;

  res.json({ popularServices, topBarbers, revenueByDay, totalReviews: reviews.length, avgRating });
});

app.get('/api/admin/reviews', requireAdmin, (req, res) => {
  res.json(readJSON(REVIEWS_FILE).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.patch('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const reviews = readJSON(REVIEWS_FILE);
  const review = reviews.find((r) => r.id === req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  review.status = status;
  await writeJSON(REVIEWS_FILE, reviews);
  res.json({ review });
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const reviews = readJSON(REVIEWS_FILE);
  const idx = reviews.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Review not found' });
  const [removed] = reviews.splice(idx, 1);
  await writeJSON(REVIEWS_FILE, reviews);
  res.json({ review: removed });
});

app.get('/api/admin/gift-cards', requireAdmin, (req, res) => {
  res.json(readJSON(GIFTCARDS_FILE).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

// health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n  Elite Cuts Barber running → http://localhost:${PORT}`);
  console.log(`  Admin dashboard         → http://localhost:${PORT}/admin.html`);
  console.log(`  Admin login             → ${ADMIN_USER} / ${ADMIN_PASS}\n`);
});
