(() => {
  'use strict';

  const API = '/api';
  const state = {
    services: [],
    barbers: [],
    booking: { serviceId: null, barberId: null, date: null, time: null },
    step: 1,
    lastBooking: null,
  };

  // ===================== UTILITIES =====================
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  function fmtMoney(n) { return `$${Number(n).toFixed(0)}`; }

  function fmtDuration(mins) {
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function fmtDateHuman(dateStr) {
    const d = new Date(`${dateStr}T00:00:00`);
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function fmtTimeHuman(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
  }

  function toast(message, type = 'default') {
    const container = $('#toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(30px)';
      el.style.transition = 'all .3s ease';
      setTimeout(() => el.remove(), 320);
    }, 3800);
  }

  async function api(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await res.json() : null;
    if (!res.ok) {
      throw new Error(data?.error || 'Something went wrong. Please try again.');
    }
    return data;
  }

  // ===================== PRELOADER =====================
  window.addEventListener('load', () => {
    setTimeout(() => $('#preloader').classList.add('hidden'), 400);
  });

  // ===================== NAVBAR =====================
  const nav = $('#nav');
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
    updateActiveNav();
  });

  const hamburger = $('#hamburger');
  const navLinks = $('#navLinks');
  hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('open');
    navLinks.classList.toggle('open');
  });
  $$('.nav-link').forEach((l) => l.addEventListener('click', () => {
    hamburger.classList.remove('open');
    navLinks.classList.remove('open');
  }));

  const sections = ['home', 'services', 'barbers', 'gallery', 'testimonials', 'contact'];
  function updateActiveNav() {
    let current = 'home';
    for (const id of sections) {
      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top <= 140) current = id;
    }
    $$('.nav-link').forEach((l) => {
      l.classList.toggle('active', l.getAttribute('href') === `#${current}`);
    });
  }

  // ===================== SCROLL REVEAL =====================
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  $$('.reveal').forEach((el) => revealObserver.observe(el));

  // ===================== STAT COUNT-UP =====================
  const statObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const target = parseFloat(el.dataset.count);
      const decimals = parseInt(el.dataset.decimal || '0', 10);
      const duration = 1400;
      const start = performance.now();
      function tick(now) {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = (target * eased).toFixed(decimals).toLocaleString();
        if (progress < 1) requestAnimationFrame(tick);
        else el.textContent = target.toLocaleString(undefined, { minimumFractionDigits: decimals });
      }
      requestAnimationFrame(tick);
      statObserver.unobserve(el);
    });
  }, { threshold: 0.5 });
  $$('.stat-num').forEach((el) => statObserver.observe(el));

  // ===================== RENDER: SERVICES =====================
  function serviceIcon(category) {
    return { Hair: '💇', Beard: '🧔', Shave: '🪒', Combo: '⭐', Color: '🎨' }[category] || '✂️';
  }

  function renderServices(filter = 'all') {
    const grid = $('#servicesGrid');
    const list = filter === 'all' ? state.services : state.services.filter((s) => s.category === filter);
    grid.innerHTML = list.map((s) => `
      <div class="service-card">
        <div class="service-card-top">
          <div>
            <span class="service-category">${s.category}</span>
            <div class="service-name" style="margin-top:10px;">${serviceIcon(s.category)} ${s.name}</div>
          </div>
          <div class="service-price">${fmtMoney(s.price)}</div>
        </div>
        <p class="service-desc">${s.description}</p>
        <div class="service-meta">
          <span class="service-duration">⏱ ${fmtDuration(s.duration)}</span>
        </div>
        <button class="btn btn-outline service-book-btn" data-book-service="${s.id}">Book This Service</button>
      </div>
    `).join('');

    $$('[data-book-service]', grid).forEach((btn) => {
      btn.addEventListener('click', () => {
        resetBooking();
        openBooking();
        selectService(btn.dataset.bookService);
        goToStep(2);
      });
    });
  }

  $$('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderServices(chip.dataset.filter);
    });
  });

  // ===================== RENDER: BARBERS =====================
  function renderBarbers() {
    const grid = $('#barbersGrid');
    grid.innerHTML = state.barbers.map((b) => `
      <div class="barber-card">
        <div class="barber-img-wrap">
          <img src="${b.avatar}" alt="${b.name}" loading="lazy" />
          <span class="barber-rating">★ ${b.rating}</span>
        </div>
        <div class="barber-body">
          <div class="barber-name">${b.name}</div>
          <div class="barber-title">${b.title}</div>
          <p class="barber-bio">${b.bio}</p>
          <p class="barber-specialty"><strong>Specialty:</strong> ${b.specialty}</p>
          <button class="btn btn-outline btn-full" data-book-barber="${b.id}">Book with ${b.name.split(' ')[0]}</button>
        </div>
      </div>
    `).join('');

    $$('[data-book-barber]', grid).forEach((btn) => {
      btn.addEventListener('click', () => {
        resetBooking();
        openBooking();
        selectBarber(btn.dataset.bookBarber);
        goToStep(1);
      });
    });
  }

  // ===================== RENDER: GALLERY =====================
  const galleryImages = [
    'https://images.unsplash.com/photo-1599351431202-1e0f0137899a?q=80&w=500&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1622286342621-4bd786c2447c?q=80&w=500&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1521590832167-7bcbfaa6381f?q=80&w=500&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1512690459411-b9245aed614b?q=80&w=500&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1599351431202-1e0f0137899a?q=80&w=500&auto=format&fit=crop&sat=-100',
    'https://images.unsplash.com/photo-1585747860715-2ba37e788b70?q=80&w=500&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?q=80&w=500&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1634449571010-02389ed0f9b0?q=80&w=500&auto=format&fit=crop',
  ];
  function renderGallery() {
    $('#galleryGrid').innerHTML = galleryImages.map((src, i) => `
      <div class="gallery-item" data-index="${i}"><img src="${src}" alt="Barbershop gallery" loading="lazy" /></div>
    `).join('');
    $$('.gallery-item', $('#galleryGrid')).forEach((item) => {
      item.addEventListener('click', () => openLightbox(Number(item.dataset.index)));
    });
  }

  // ---- lightbox ----
  let lightboxIndex = 0;
  const lightbox = $('#lightbox');

  function openLightbox(index) {
    lightboxIndex = index;
    updateLightbox();
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    lightbox.classList.remove('open');
    document.body.style.overflow = '';
  }
  function updateLightbox() {
    $('#lightboxImg').src = galleryImages[lightboxIndex];
  }
  $('#lightboxClose').addEventListener('click', closeLightbox);
  $('#lightboxPrev').addEventListener('click', () => {
    lightboxIndex = (lightboxIndex - 1 + galleryImages.length) % galleryImages.length;
    updateLightbox();
  });
  $('#lightboxNext').addEventListener('click', () => {
    lightboxIndex = (lightboxIndex + 1) % galleryImages.length;
    updateLightbox();
  });
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });

  // ===================== TESTIMONIALS =====================
  const testimonials = [
    { text: "Best barbershop experience I've had. Marcus nailed the fade exactly how I wanted it. The hot towel shave is unreal.", name: 'Ryan Cooper', role: 'Regular Client', img: 'https://i.pravatar.cc/100?img=51' },
    { text: 'The online booking made it so easy — picked my time, showed up, no waiting. Diego is a true artist with the clippers.', name: 'Marcus Bell', role: 'Verified Client', img: 'https://i.pravatar.cc/100?img=52' },
    { text: "Elite Cuts feels like a members club, not a barbershop. Great atmosphere, complimentary drinks, and James's color work is flawless.", name: 'Alex Kim', role: 'Verified Client', img: 'https://i.pravatar.cc/100?img=53' },
    { text: "Took my son for his first haircut and Leo was incredibly patient with him. We're customers for life now.", name: 'David Torres', role: 'Parent & Client', img: 'https://i.pravatar.cc/100?img=54' },
  ];
  let testIndex = 0;
  function renderTestimonials() {
    $('#testimonialTrack').innerHTML = testimonials.map((t) => `
      <div class="testimonial-card">
        <div class="testimonial-stars">★★★★★</div>
        <p class="testimonial-text">"${t.text}"</p>
        <div class="testimonial-author">
          <img src="${t.img}" alt="${t.name}" />
          <div><strong>${t.name}</strong><span>${t.role}</span></div>
        </div>
      </div>
    `).join('');
    $('#testDots').innerHTML = testimonials.map((_, i) => `<span class="dot${i === 0 ? ' active' : ''}" data-index="${i}"></span>`).join('');
    $$('.dot', $('#testDots')).forEach((dot) => {
      dot.addEventListener('click', () => {
        testIndex = Number(dot.dataset.index);
        updateTestSlide();
        clearInterval(testAutoplay);
      });
    });
    updateTestSlide();
  }
  function updateTestSlide() {
    const track = $('#testimonialTrack');
    track.style.transform = `translateX(-${testIndex * 100}%)`;
    $$('.dot').forEach((d, i) => d.classList.toggle('active', i === testIndex));
  }
  $('#testPrev').addEventListener('click', () => {
    testIndex = (testIndex - 1 + testimonials.length) % testimonials.length;
    updateTestSlide();
  });
  $('#testNext').addEventListener('click', () => {
    testIndex = (testIndex + 1) % testimonials.length;
    updateTestSlide();
  });
  let testAutoplay = setInterval(() => $('#testNext').click(), 6000);
  $('.testimonial-slider')?.addEventListener('mouseenter', () => clearInterval(testAutoplay));

  // ===================== LOAD DATA =====================
  async function loadInitialData() {
    try {
      const [services, barbers] = await Promise.all([
        api('/services'),
        api('/barbers'),
      ]);
      state.services = services;
      state.barbers = barbers;
      renderServices();
      renderBarbers();
      renderBookingServiceList();
      renderBookingBarberList();
    } catch (e) {
      toast('Could not load site data. Is the server running?', 'error');
    }
  }
  renderGallery();
  renderTestimonials();
  loadInitialData();
  $('#year').textContent = new Date().getFullYear();

  // ===================== BOOKING MODAL =====================
  const bookingModal = $('#bookingModal');
  const confirmModal = $('#confirmModal');

  function openBooking() {
    bookingModal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeBooking() {
    bookingModal.classList.remove('open');
    document.body.style.overflow = '';
  }
  ['openBookingNav', 'openBookingHero', 'openBookingAbout', 'openBookingCta'].forEach((id) => {
    $(`#${id}`)?.addEventListener('click', () => { resetBooking(); openBooking(); });
  });
  $('#closeBooking').addEventListener('click', closeBooking);
  bookingModal.addEventListener('click', (e) => { if (e.target === bookingModal) closeBooking(); });

  function resetBooking() {
    state.booking = { serviceId: null, barberId: null, date: null, time: null };
    state.step = 1;
    goToStep(1);
    resetDatePicker();
    $('#timeSlots').innerHTML = '<p class="hint">Select a date to see available times.</p>';
    $('#custName').value = '';
    $('#custEmail').value = '';
    $('#custPhone').value = '';
    $('#custNotes').value = '';
    $('#bookingStatus').textContent = '';
    $('#bookingStatus').className = 'form-status';
    renderBookingServiceList();
    renderBookingBarberList();
  }

  function renderBookingServiceList() {
    $('#bookingServiceList').innerHTML = state.services.map((s) => `
      <div class="pick-card" data-service="${s.id}">
        <div class="pick-card-left">
          <div>
            <div class="pick-card-title">${serviceIcon(s.category)} ${s.name}</div>
            <div class="pick-card-sub">${fmtDuration(s.duration)} · ${s.category}</div>
          </div>
        </div>
        <div class="pick-card-price">${fmtMoney(s.price)}</div>
      </div>
    `).join('');
    $$('.pick-card', $('#bookingServiceList')).forEach((card) => {
      card.addEventListener('click', () => selectService(card.dataset.service));
    });
  }

  function renderBookingBarberList() {
    $('#bookingBarberList').innerHTML = `
      <div class="pick-card" data-barber="any">
        <div class="pick-card-left">
          <div style="width:44px;height:44px;border-radius:50%;background:var(--charcoal-light);display:flex;align-items:center;justify-content:center;font-size:20px;">✨</div>
          <div>
            <div class="pick-card-title">Any Available Barber</div>
            <div class="pick-card-sub">We'll match you with the first opening</div>
          </div>
        </div>
      </div>
      ${state.barbers.map((b) => `
        <div class="pick-card" data-barber="${b.id}">
          <div class="pick-card-left">
            <img src="${b.avatar}" alt="${b.name}" />
            <div>
              <div class="pick-card-title">${b.name}</div>
              <div class="pick-card-sub">${b.specialty}</div>
            </div>
          </div>
          <div class="pick-card-price" style="font-size:14px;">★ ${b.rating}</div>
        </div>
      `).join('')}
    `;
    $$('.pick-card', $('#bookingBarberList')).forEach((card) => {
      card.addEventListener('click', () => selectBarber(card.dataset.barber));
    });
  }

  function selectService(id) {
    state.booking.serviceId = id;
    $$('.pick-card', $('#bookingServiceList')).forEach((c) => c.classList.toggle('selected', c.dataset.service === id));
  }

  function selectBarber(id) {
    if (id === 'any') {
      const eligible = state.barbers.filter((b) => b.workDays.length > 0);
      id = eligible[Math.floor(Math.random() * eligible.length)]?.id || state.barbers[0].id;
    }
    state.booking.barberId = id;
    $$('.pick-card', $('#bookingBarberList')).forEach((c) => c.classList.toggle('selected', c.dataset.barber === id));
  }

  // ===================== CUSTOM DATE PICKER =====================
  const datePicker = $('#datePicker');
  const dateTrigger = $('#dateTrigger');
  const dateTriggerLabel = $('#dateTriggerLabel');
  const datePanel = $('#datePanel');
  const calendarLabel = $('#calendarLabel');
  const calendarGrid = $('#calendarGrid');
  const prevMonthBtn = $('#prevMonth');
  const nextMonthBtn = $('#nextMonth');
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const toDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const minDate = new Date(today);
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + 60);
  let calendarView = new Date(today.getFullYear(), today.getMonth(), 1);

  function renderCalendar() {
    calendarLabel.textContent = `${monthNames[calendarView.getMonth()]} ${calendarView.getFullYear()}`;
    const firstDay = new Date(calendarView.getFullYear(), calendarView.getMonth(), 1);
    const daysInMonth = new Date(calendarView.getFullYear(), calendarView.getMonth() + 1, 0).getDate();

    let html = '';
    for (let i = 0; i < firstDay.getDay(); i++) html += '<span class="date-cell empty"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const cellDate = new Date(calendarView.getFullYear(), calendarView.getMonth(), d);
      const dateStr = toDateStr(cellDate);
      const disabled = cellDate < minDate || cellDate > maxDate;
      const classes = ['date-cell'];
      if (disabled) classes.push('disabled');
      if (cellDate.getTime() === today.getTime()) classes.push('today');
      if (state.booking.date === dateStr) classes.push('selected');
      html += `<button type="button" class="${classes.join(' ')}" data-date="${dateStr}" ${disabled ? 'disabled' : ''}>${d}</button>`;
    }
    calendarGrid.innerHTML = html;

    prevMonthBtn.disabled = calendarView.getFullYear() === minDate.getFullYear() && calendarView.getMonth() === minDate.getMonth();
    nextMonthBtn.disabled = calendarView.getFullYear() === maxDate.getFullYear() && calendarView.getMonth() === maxDate.getMonth();

    $$('.date-cell:not(.empty):not(.disabled)', calendarGrid).forEach((el) => {
      el.addEventListener('click', () => selectDate(el.dataset.date));
    });
  }

  async function selectDate(dateStr) {
    state.booking.date = dateStr;
    state.booking.time = null;
    const d = new Date(`${dateStr}T00:00:00`);
    dateTriggerLabel.textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    datePanel.classList.remove('open');
    renderCalendar();
    await loadTimeSlots();
  }

  function resetDatePicker() {
    calendarView = new Date(today.getFullYear(), today.getMonth(), 1);
    dateTriggerLabel.textContent = 'Select a date';
    datePanel.classList.remove('open');
    renderCalendar();
  }

  prevMonthBtn.addEventListener('click', () => { calendarView.setMonth(calendarView.getMonth() - 1); renderCalendar(); });
  nextMonthBtn.addEventListener('click', () => { calendarView.setMonth(calendarView.getMonth() + 1); renderCalendar(); });
  dateTrigger.addEventListener('click', (e) => { e.stopPropagation(); datePanel.classList.toggle('open'); });
  document.addEventListener('click', (e) => { if (!datePicker.contains(e.target)) datePanel.classList.remove('open'); });
  renderCalendar();

  async function loadTimeSlots() {
    const slotsEl = $('#timeSlots');
    if (!state.booking.date || !state.booking.barberId || !state.booking.serviceId) return;
    slotsEl.innerHTML = '<p class="hint">Loading available times…</p>';
    try {
      const data = await api(`/availability?barberId=${state.booking.barberId}&date=${state.booking.date}&serviceId=${state.booking.serviceId}`);
      if (!data.slots.length) {
        slotsEl.innerHTML = '<p class="hint">No availability that day. Try another date.</p>';
        return;
      }
      slotsEl.innerHTML = data.slots.map((t) => `<div class="time-slot" data-time="${t}">${fmtTimeHuman(t)}</div>`).join('');
      $$('.time-slot', slotsEl).forEach((el) => {
        el.addEventListener('click', () => {
          state.booking.time = el.dataset.time;
          $$('.time-slot', slotsEl).forEach((s) => s.classList.remove('selected'));
          el.classList.add('selected');
        });
      });
    } catch (e) {
      slotsEl.innerHTML = `<p class="hint">${e.message}</p>`;
    }
  }

  // ===================== STEP NAVIGATION =====================
  function goToStep(n) {
    state.step = n;
    $$('.booking-panel').forEach((p) => p.classList.toggle('active', Number(p.dataset.panel) === n));
    $$('.step').forEach((s) => {
      const stepNum = Number(s.dataset.step);
      s.classList.toggle('active', stepNum === n);
      s.classList.toggle('done', stepNum < n);
    });
    $('#bookingBack').style.visibility = n === 1 ? 'hidden' : 'visible';
    $('#bookingNext').textContent = n === 5 ? 'Confirm & Book' : 'Continue';

    if (n === 3 && state.booking.date) loadTimeSlots();
    if (n === 5) renderSummary();
  }

  function validateStep(n) {
    if (n === 1 && !state.booking.serviceId) { toast('Please select a service', 'error'); return false; }
    if (n === 2 && !state.booking.barberId) { toast('Please select a barber', 'error'); return false; }
    if (n === 3 && (!state.booking.date || !state.booking.time)) { toast('Please pick a date and time', 'error'); return false; }
    if (n === 4) {
      const name = $('#custName').value.trim();
      const email = $('#custEmail').value.trim();
      const phone = $('#custPhone').value.trim();
      if (!name || !email || !phone) { toast('Please fill in all required fields', 'error'); return false; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Please enter a valid email', 'error'); return false; }
    }
    return true;
  }

  function renderSummary() {
    const service = state.services.find((s) => s.id === state.booking.serviceId);
    const barber = state.barbers.find((b) => b.id === state.booking.barberId);
    $('#summaryCard').innerHTML = `
      <div class="summary-row"><span>Service</span><span>${service.name}</span></div>
      <div class="summary-row"><span>Barber</span><span>${barber.name}</span></div>
      <div class="summary-row"><span>Date</span><span>${fmtDateHuman(state.booking.date)}</span></div>
      <div class="summary-row"><span>Time</span><span>${fmtTimeHuman(state.booking.time)}</span></div>
      <div class="summary-row"><span>Duration</span><span>${fmtDuration(service.duration)}</span></div>
      <div class="summary-row"><span>Name</span><span>${$('#custName').value}</span></div>
      <div class="summary-row"><span>Contact</span><span>${$('#custEmail').value}</span></div>
      <div class="summary-row"><span>Total</span><span class="summary-total">${fmtMoney(service.price)}</span></div>
    `;
  }

  $('#bookingBack').addEventListener('click', () => { if (state.step > 1) goToStep(state.step - 1); });

  $('#bookingNext').addEventListener('click', async () => {
    if (!validateStep(state.step)) return;
    if (state.step < 5) { goToStep(state.step + 1); return; }

    // submit booking
    const btn = $('#bookingNext');
    btn.disabled = true;
    btn.textContent = 'Booking…';
    const statusEl = $('#bookingStatus');
    statusEl.textContent = '';
    statusEl.className = 'form-status';
    try {
      const { booking } = await api('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: state.booking.serviceId,
          barberId: state.booking.barberId,
          date: state.booking.date,
          time: state.booking.time,
          name: $('#custName').value.trim(),
          email: $('#custEmail').value.trim(),
          phone: $('#custPhone').value.trim(),
          notes: $('#custNotes').value.trim(),
        }),
      });
      state.lastBooking = booking;
      closeBooking();
      showConfirmation(booking);
      toast('Appointment booked successfully!', 'success');
    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.className = 'form-status error';
      if (e.message.includes('no longer available') || e.message.includes('just booked')) {
        goToStep(3);
        loadTimeSlots();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirm & Book';
    }
  });

  // ===================== CONFIRMATION =====================
  function showConfirmation(booking) {
    $('#confirmSummary').innerHTML = `
      <div class="summary-row"><span>Confirmation #</span><span>${booking.id.slice(0, 8).toUpperCase()}</span></div>
      <div class="summary-row"><span>Service</span><span>${booking.serviceName}</span></div>
      <div class="summary-row"><span>Barber</span><span>${booking.barberName}</span></div>
      <div class="summary-row"><span>Date</span><span>${fmtDateHuman(booking.date)}</span></div>
      <div class="summary-row"><span>Time</span><span>${fmtTimeHuman(booking.time)}</span></div>
      <div class="summary-row"><span>Total</span><span class="summary-total">${fmtMoney(booking.price)}</span></div>
    `;
    confirmModal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  $('#closeConfirm').addEventListener('click', () => {
    confirmModal.classList.remove('open');
    document.body.style.overflow = '';
  });
  confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) $('#closeConfirm').click(); });

  $('#downloadIcs').addEventListener('click', () => {
    const b = state.lastBooking;
    if (!b) return;
    const start = new Date(`${b.date}T${b.time}:00`);
    const end = new Date(start.getTime() + b.duration * 60000);
    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Elite Cuts//Booking//EN', 'BEGIN:VEVENT',
      `UID:${b.id}@elitecuts.com`,
      `DTSTAMP:${fmt(new Date())}`,
      `DTSTART:${fmt(start)}`,
      `DTEND:${fmt(end)}`,
      `SUMMARY:${b.serviceName} at Elite Cuts with ${b.barberName}`,
      `DESCRIPTION:Appointment confirmation #${b.id.slice(0, 8).toUpperCase()}`,
      'LOCATION:128 Fifth Avenue, Downtown District, NY 10011',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const blob = new Blob([ics], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'elite-cuts-appointment.ics';
    a.click();
    URL.revokeObjectURL(url);
  });

  // ===================== CONTACT FORM =====================
  $('#contactForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const statusEl = $('#contactStatus');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/contact', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.value.trim(),
          email: form.email.value.trim(),
          message: form.message.value.trim(),
        }),
      });
      statusEl.textContent = "Message sent! We'll get back to you within 24 hours.";
      statusEl.className = 'form-status success';
      form.reset();
      toast('Message sent successfully!', 'success');
    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.className = 'form-status error';
    } finally {
      btn.disabled = false;
    }
  });

  // ===================== NEWSLETTER FORM =====================
  $('#newsletterForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await api('/newsletter', { method: 'POST', body: JSON.stringify({ email: form.email.value.trim() }) });
      toast("You're subscribed! Welcome to the inner circle.", 'success');
      form.reset();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // ===================== GLOBAL ESC TO CLOSE MODALS =====================
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (bookingModal.classList.contains('open')) closeBooking();
      if (confirmModal.classList.contains('open')) $('#closeConfirm').click();
      if (lightbox.classList.contains('open')) closeLightbox();
    }
    if (lightbox.classList.contains('open')) {
      if (e.key === 'ArrowLeft') $('#lightboxPrev').click();
      if (e.key === 'ArrowRight') $('#lightboxNext').click();
    }
  });
})();
