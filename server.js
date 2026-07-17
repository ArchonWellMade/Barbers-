require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required');
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

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

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function toHHMM(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}
function isPastDateTime(dateStr, timeStr) {
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  return dt.getTime() < Date.now();
}
// escape LIKE/ILIKE wildcards so a filter behaves as an exact, case-insensitive match
function escapeLike(str) {
  return str.replace(/[%_\\]/g, '\\$&');
}

// ---------- row <-> API shape mappers ----------
function rowToBarber(r) {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    bio: r.bio,
    specialty: r.specialty,
    avatar: r.avatar,
    rating: Number(r.rating),
    workDays: r.work_days,
    startHour: r.start_hour,
    endHour: r.end_hour,
  };
}
function rowToService(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    price: Number(r.price),
    duration: r.duration,
    category: r.category,
  };
}
function rowToBooking(r) {
  return {
    id: r.id,
    serviceId: r.service_id,
    serviceName: r.service_name,
    basePrice: Number(r.base_price),
    loyaltyDiscount: Number(r.loyalty_discount),
    loyaltyTier: r.loyalty_tier,
    giftCardCode: r.gift_card_code,
    giftCardDiscount: Number(r.gift_card_discount),
    price: Number(r.price),
    duration: r.duration,
    barberId: r.barber_id,
    barberName: r.barber_name,
    date: r.date,
    time: r.time,
    name: r.name,
    email: r.email,
    phone: r.phone,
    notes: r.notes,
    status: r.status,
    createdAt: r.created_at,
    rescheduledAt: r.rescheduled_at || undefined,
  };
}
function rowToGiftCard(r) {
  return {
    code: r.code,
    initialAmount: Number(r.initial_amount),
    balance: Number(r.balance),
    senderName: r.sender_name,
    senderEmail: r.sender_email,
    recipientName: r.recipient_name,
    recipientEmail: r.recipient_email,
    message: r.message,
    redemptions: r.redemptions,
    createdAt: r.created_at,
  };
}
function rowToReview(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    rating: r.rating,
    text: r.text,
    serviceId: r.service_id,
    status: r.status,
    createdAt: r.created_at,
  };
}
function rowToContact(r) {
  return { id: r.id, name: r.name, email: r.email, message: r.message, createdAt: r.created_at };
}

async function getBarber(barberId) {
  const { data, error } = await supabase.from('barber_barbers').select('*').eq('id', barberId).maybeSingle();
  if (error) throw error;
  return data ? rowToBarber(data) : null;
}
async function getService(serviceId) {
  const { data, error } = await supabase.from('barber_services').select('*').eq('id', serviceId).maybeSingle();
  if (error) throw error;
  return data ? rowToService(data) : null;
}
async function getGiftCard(code) {
  if (!code) return null;
  const normalized = String(code).trim().toUpperCase();
  const { data, error } = await supabase.from('barber_giftcards').select('*').eq('code', normalized).maybeSingle();
  if (error) throw error;
  return data ? rowToGiftCard(data) : null;
}

async function computeAvailableSlots({ barberId, date, serviceId, excludeBookingId }) {
  const [barber, service] = await Promise.all([getBarber(barberId), getService(serviceId)]);
  if (!barber || !service) return { error: 'Invalid barber or service', slots: [] };

  const dateObj = new Date(`${date}T00:00:00`);
  const dayOfWeek = dateObj.getDay();
  if (!barber.workDays.includes(dayOfWeek)) {
    return { error: null, slots: [] };
  }

  const startMin = barber.startHour * 60;
  const endMin = barber.endHour * 60;
  const duration = service.duration;

  let query = supabase
    .from('barber_bookings')
    .select('time, duration')
    .eq('barber_id', barberId)
    .eq('date', date)
    .neq('status', 'cancelled');
  if (excludeBookingId) query = query.neq('id', excludeBookingId);
  const { data: busyRows, error } = await query;
  if (error) throw error;

  const busyRanges = busyRows.map((b) => {
    const bStart = toMinutes(b.time);
    return [bStart, bStart + b.duration];
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

async function computeLoyalty(email) {
  if (!email) {
    return {
      email: null,
      visits: 0,
      tier: LOYALTY_TIERS[0].name,
      discountPercent: 0,
      nextTier: LOYALTY_TIERS[1],
      visitsToNextTier: LOYALTY_TIERS[1].minVisits,
    };
  }
  const normalized = String(email).toLowerCase();
  const { count, error } = await supabase
    .from('barber_bookings')
    .select('id', { count: 'exact', head: true })
    .ilike('email', escapeLike(normalized))
    .neq('status', 'cancelled');
  if (error) throw error;
  const visits = count || 0;

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
async function generateUniqueGiftCardCode() {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  for (let i = 0; i < 20; i++) {
    const code = `EC-${part()}-${part()}`;
    const { data, error } = await supabase.from('barber_giftcards').select('code').eq('code', code).maybeSingle();
    if (error) throw error;
    if (!data) return code;
  }
  throw new Error('Could not generate a unique gift card code');
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

app.get('/api/services', async (req, res) => {
  const { data, error } = await supabase.from('barber_services').select('*').order('sort_order');
  if (error) return res.status(500).json({ error: 'Failed to load services' });
  res.json(data.map(rowToService));
});

app.get('/api/barbers', async (req, res) => {
  const { data, error } = await supabase.from('barber_barbers').select('*').order('sort_order');
  if (error) return res.status(500).json({ error: 'Failed to load barbers' });
  res.json(data.map(rowToBarber));
});

app.get('/api/availability', async (req, res) => {
  const { barberId, date, serviceId } = req.query;
  if (!barberId || !date || !serviceId) {
    return res.status(400).json({ error: 'barberId, date and serviceId are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format, expected YYYY-MM-DD' });
  }
  const { error, slots } = await computeAvailableSlots({ barberId, date, serviceId });
  if (error) return res.status(400).json({ error });
  res.json({ date, barberId, serviceId, slots });
});

app.get('/api/loyalty', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email is required' });
  res.json(await computeLoyalty(email));
});

app.get('/api/gift-cards/:code', async (req, res) => {
  const card = await getGiftCard(req.params.code);
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

  const code = await generateUniqueGiftCardCode();
  const { data, error } = await supabase
    .from('barber_giftcards')
    .insert({
      code,
      initial_amount: amt,
      balance: amt,
      sender_name: String(senderName).trim(),
      sender_email: String(senderEmail).trim(),
      recipient_name: String(recipientName).trim(),
      recipient_email: recipientEmail ? String(recipientEmail).trim() : '',
      message: message ? String(message).trim().slice(0, 300) : '',
      redemptions: [],
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'Failed to create gift card' });
  res.status(201).json({ giftCard: rowToGiftCard(data) });
});

app.get('/api/stats/public', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const [todayResult, weekResult] = await Promise.all([
    supabase.from('barber_bookings').select('id', { count: 'exact', head: true }).eq('date', today).neq('status', 'cancelled'),
    supabase.from('barber_bookings').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo).neq('status', 'cancelled'),
  ]);
  if (todayResult.error || weekResult.error) return res.status(500).json({ error: 'Failed to load stats' });
  res.json({ bookedToday: todayResult.count || 0, bookedThisWeek: weekResult.count || 0 });
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
  const [service, barber] = await Promise.all([getService(serviceId), getBarber(barberId)]);
  if (!service) return res.status(400).json({ error: 'Unknown service' });
  if (!barber) return res.status(400).json({ error: 'Unknown barber' });
  if (isPastDateTime(date, time)) {
    return res.status(400).json({ error: 'Cannot book a time in the past' });
  }

  // check slot is free (final guarantee against double-booking is the DB exclusion constraint below)
  const { slots } = await computeAvailableSlots({ barberId, date, serviceId });
  if (!slots.includes(time)) {
    return res.status(409).json({ error: 'That time slot is no longer available. Please pick another.' });
  }

  let giftCard = null;
  if (giftCardCode) {
    giftCard = await getGiftCard(giftCardCode);
    if (!giftCard) return res.status(400).json({ error: 'Gift card not found' });
    if (giftCard.balance <= 0) return res.status(400).json({ error: 'Gift card has no remaining balance' });
  }

  const loyalty = await computeLoyalty(email);
  const basePrice = service.price;
  const loyaltyDiscount = Math.round(basePrice * (loyalty.discountPercent / 100) * 100) / 100;
  const priceAfterLoyalty = Math.round((basePrice - loyaltyDiscount) * 100) / 100;
  const giftCardDiscount = giftCard ? Math.min(giftCard.balance, priceAfterLoyalty) : 0;
  const finalPrice = Math.round((priceAfterLoyalty - giftCardDiscount) * 100) / 100;

  const { data: bookingRow, error: insertError } = await supabase
    .from('barber_bookings')
    .insert({
      service_id: serviceId,
      service_name: service.name,
      base_price: basePrice,
      loyalty_discount: loyaltyDiscount,
      loyalty_tier: loyalty.tier,
      gift_card_code: giftCard ? giftCard.code : null,
      gift_card_discount: giftCardDiscount,
      price: finalPrice,
      duration: service.duration,
      barber_id: barberId,
      barber_name: barber.name,
      date,
      time,
      name: String(name).trim(),
      email: String(email).trim(),
      phone: String(phone).trim(),
      notes: notes ? String(notes).trim().slice(0, 500) : '',
      status: 'confirmed',
    })
    .select()
    .single();

  if (insertError) {
    // 23P01 = exclusion constraint violation, i.e. someone else just booked this slot
    if (insertError.code === '23P01') {
      return res.status(409).json({ error: 'That time slot was just booked. Please pick another.' });
    }
    return res.status(500).json({ error: 'Failed to create booking' });
  }
  const booking = rowToBooking(bookingRow);

  if (giftCard && giftCardDiscount > 0) {
    const freshCard = await getGiftCard(giftCard.code);
    if (freshCard) {
      const newBalance = Math.round((freshCard.balance - giftCardDiscount) * 100) / 100;
      const redemptions = [...freshCard.redemptions, { bookingId: booking.id, amount: giftCardDiscount, date: new Date().toISOString() }];
      await supabase.from('barber_giftcards').update({ balance: newBalance, redemptions }).eq('code', freshCard.code);
    }
  }

  res.status(201).json({ booking });
});

// lookup a booking (for "manage my booking" by id + email)
app.get('/api/bookings/:id', async (req, res) => {
  const { email } = req.query;
  const { data, error } = await supabase.from('barber_bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to load booking' });
  if (!data) return res.status(404).json({ error: 'Booking not found' });
  const booking = rowToBooking(data);
  if (email && booking.email.toLowerCase() !== String(email).toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match booking' });
  }
  res.json({ booking });
});

app.post('/api/bookings/:id/cancel', async (req, res) => {
  const { email } = req.body || {};
  const { data, error } = await supabase.from('barber_bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to load booking' });
  if (!data) return res.status(404).json({ error: 'Booking not found' });
  const booking = rowToBooking(data);
  if (!email || booking.email.toLowerCase() !== String(email).toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match booking' });
  }
  const { data: updated, error: updateError } = await supabase
    .from('barber_bookings')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id)
    .select()
    .single();
  if (updateError) return res.status(500).json({ error: 'Failed to cancel booking' });
  res.json({ booking: rowToBooking(updated) });
});

app.post('/api/bookings/:id/reschedule', async (req, res) => {
  const { email, date, time } = req.body || {};
  if (!email || !date || !time) {
    return res.status(400).json({ error: 'email, date and time are required' });
  }
  const { data, error } = await supabase.from('barber_bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to load booking' });
  if (!data) return res.status(404).json({ error: 'Booking not found' });
  const booking = rowToBooking(data);
  if (booking.email.toLowerCase() !== String(email).toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match booking' });
  }
  if (booking.status === 'cancelled') {
    return res.status(400).json({ error: 'This booking has been cancelled and cannot be rescheduled' });
  }
  if (isPastDateTime(date, time)) {
    return res.status(400).json({ error: 'Cannot reschedule to a time in the past' });
  }

  const { error: slotsError, slots } = await computeAvailableSlots({
    barberId: booking.barberId,
    date,
    serviceId: booking.serviceId,
    excludeBookingId: booking.id,
  });
  if (slotsError) return res.status(400).json({ error: slotsError });
  if (!slots.includes(time)) {
    return res.status(409).json({ error: 'That time slot is not available. Please pick another.' });
  }

  const { data: updated, error: updateError } = await supabase
    .from('barber_bookings')
    .update({ date, time, rescheduled_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (updateError) {
    if (updateError.code === '23P01') {
      return res.status(409).json({ error: 'That time slot was just booked. Please pick another.' });
    }
    return res.status(500).json({ error: 'Failed to reschedule booking' });
  }
  res.json({ booking: rowToBooking(updated) });
});

app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required' });
  }
  const { error } = await supabase.from('barber_contacts').insert({
    name: String(name).trim(),
    email: String(email).trim(),
    message: String(message).trim().slice(0, 2000),
  });
  if (error) return res.status(500).json({ error: 'Failed to submit message' });
  res.status(201).json({ ok: true });
});

app.post('/api/newsletter', async (req, res) => {
  const { email } = req.body || {};
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRe.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const { error } = await supabase.from('barber_newsletter').upsert(
    { email: String(email).trim() },
    { onConflict: 'email', ignoreDuplicates: true }
  );
  if (error) return res.status(500).json({ error: 'Failed to subscribe' });
  res.status(201).json({ ok: true });
});

app.get('/api/reviews', async (req, res) => {
  const { data, error } = await supabase
    .from('barber_reviews')
    .select('*')
    .eq('status', 'approved')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to load reviews' });
  res.json(data.map(rowToReview).map(({ email, ...rest }) => rest));
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
  const { data, error } = await supabase
    .from('barber_reviews')
    .insert({
      name: String(name).trim(),
      email: String(email).trim(),
      rating: Math.round(r),
      text: String(text).trim().slice(0, 1000),
      service_id: serviceId || null,
      status: 'pending',
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'Failed to submit review' });
  const review = rowToReview(data);
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

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('barber_bookings').select('*').order('date').order('time');
  if (error) return res.status(500).json({ error: 'Failed to load bookings' });
  res.json(data.map(rowToBooking));
});

app.patch('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['confirmed', 'completed', 'cancelled', 'no-show'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { data, error } = await supabase
    .from('barber_bookings')
    .update({ status })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to update booking' });
  if (!data) return res.status(404).json({ error: 'Booking not found' });
  res.json({ booking: rowToBooking(data) });
});

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('barber_bookings').delete().eq('id', req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to delete booking' });
  if (!data) return res.status(404).json({ error: 'Booking not found' });
  res.json({ booking: rowToBooking(data) });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from('barber_bookings').select('date, status, price');
  if (error) return res.status(500).json({ error: 'Failed to load stats' });

  const revenue = data.filter((b) => b.status !== 'cancelled').reduce((sum, b) => sum + (Number(b.price) || 0), 0);
  res.json({
    total: data.length,
    today: data.filter((b) => b.date === today && b.status !== 'cancelled').length,
    upcoming: data.filter((b) => b.date >= today && b.status === 'confirmed').length,
    cancelled: data.filter((b) => b.status === 'cancelled').length,
    revenue,
  });
});

app.get('/api/admin/contacts', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('barber_contacts').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to load contacts' });
  res.json(data.map(rowToContact));
});

app.get('/api/admin/bookings/export', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('barber_bookings').select('*').order('date').order('time');
  if (error) return res.status(500).json({ error: 'Failed to load bookings' });
  const bookings = data.map(rowToBooking);
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

app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
  const [bookingsResult, servicesResult, barbersResult, reviewsResult] = await Promise.all([
    supabase.from('barber_bookings').select('*').neq('status', 'cancelled'),
    supabase.from('barber_services').select('*'),
    supabase.from('barber_barbers').select('*'),
    supabase.from('barber_reviews').select('*').eq('status', 'approved'),
  ]);
  if (bookingsResult.error || servicesResult.error || barbersResult.error || reviewsResult.error) {
    return res.status(500).json({ error: 'Failed to load analytics' });
  }
  const bookings = bookingsResult.data.map(rowToBooking);
  const services = servicesResult.data.map(rowToService);
  const barbers = barbersResult.data.map(rowToBarber);
  const reviews = reviewsResult.data.map(rowToReview);

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

app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('barber_reviews').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to load reviews' });
  res.json(data.map(rowToReview));
});

app.patch('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const { data, error } = await supabase
    .from('barber_reviews')
    .update({ status })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to update review' });
  if (!data) return res.status(404).json({ error: 'Review not found' });
  res.json({ review: rowToReview(data) });
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('barber_reviews').delete().eq('id', req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to delete review' });
  if (!data) return res.status(404).json({ error: 'Review not found' });
  res.json({ review: rowToReview(data) });
});

app.get('/api/admin/gift-cards', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('barber_giftcards').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to load gift cards' });
  res.json(data.map(rowToGiftCard));
});

// health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Elite Cuts Barber running → http://localhost:${PORT}`);
    console.log(`  Admin dashboard         → http://localhost:${PORT}/admin.html`);
    console.log(`  Admin login             → ${ADMIN_USER} / ${ADMIN_PASS}\n`);
  });
}

module.exports = app;
