-- Elite Cuts Barber Shop schema
-- Paste this whole file into the Supabase SQL Editor for project fxzxftxejbeconwwpweg
-- (https://supabase.com/dashboard/project/fxzxftxejbeconwwpweg/sql/new) and click Run.

create extension if not exists btree_gist;

create table public.barber_barbers (
  id text primary key,
  name text not null,
  title text not null,
  bio text not null default '',
  specialty text not null default '',
  avatar text not null default '',
  rating numeric not null default 5,
  work_days int[] not null default '{}',
  start_hour int not null,
  end_hour int not null,
  sort_order int not null default 0
);

create table public.barber_services (
  id text primary key,
  name text not null,
  description text not null default '',
  price numeric not null,
  duration int not null,
  category text not null default '',
  sort_order int not null default 0
);

create table public.barber_bookings (
  id uuid primary key default gen_random_uuid(),
  service_id text not null references public.barber_services(id),
  service_name text not null,
  base_price numeric not null,
  loyalty_discount numeric not null default 0,
  loyalty_tier text,
  gift_card_code text,
  gift_card_discount numeric not null default 0,
  price numeric not null,
  duration int not null,
  barber_id text not null references public.barber_barbers(id),
  barber_name text not null,
  date date not null,
  time text not null,
  name text not null,
  email text not null,
  phone text not null,
  notes text not null default '',
  status text not null default 'confirmed',
  created_at timestamptz not null default now(),
  rescheduled_at timestamptz
);
create index barber_bookings_barber_date_idx on public.barber_bookings (barber_id, date);
create index barber_bookings_email_idx on public.barber_bookings (email);

create table public.barber_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create table public.barber_newsletter (
  email text primary key,
  created_at timestamptz not null default now()
);

create table public.barber_reviews (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  rating int not null,
  text text not null,
  service_id text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table public.barber_giftcards (
  code text primary key,
  initial_amount numeric not null,
  balance numeric not null,
  sender_name text not null,
  sender_email text not null,
  recipient_name text not null,
  recipient_email text not null default '',
  message text not null default '',
  redemptions jsonb not null default '[]',
  created_at timestamptz not null default now()
);

alter table public.barber_barbers enable row level security;
alter table public.barber_services enable row level security;
alter table public.barber_bookings enable row level security;
alter table public.barber_contacts enable row level security;
alter table public.barber_newsletter enable row level security;
alter table public.barber_reviews enable row level security;
alter table public.barber_giftcards enable row level security;

-- prevent double-booking at the database level, regardless of app-level races
alter table public.barber_bookings
  add column slot_range tsrange generated always as (
    tsrange(
      make_timestamp(
        extract(year from date)::int,
        extract(month from date)::int,
        extract(day from date)::int,
        split_part("time", ':', 1)::int,
        split_part("time", ':', 2)::int,
        0
      ),
      make_timestamp(
        extract(year from date)::int,
        extract(month from date)::int,
        extract(day from date)::int,
        split_part("time", ':', 1)::int,
        split_part("time", ':', 2)::int,
        0
      ) + make_interval(mins => duration)
    )
  ) stored;

alter table public.barber_bookings
  add constraint barber_bookings_no_overlap
  exclude using gist (barber_id with =, slot_range with &&)
  where (status <> 'cancelled');

-- seed data
insert into public.barber_barbers (id, name, title, bio, specialty, avatar, rating, work_days, start_hour, end_hour, sort_order) values
('marcus-reed', 'Marcus Reed', 'Founder & Master Barber', '20+ years behind the chair. Marcus trained in London and NYC before opening Elite Cuts. Specialist in classic tapers and straight-razor shaves.', 'Classic Cuts & Shaves', 'https://i.pravatar.cc/300?img=13', 5.0, '{1,2,3,4,5,6}', 9, 19, 1),
('diego-alvarez', 'Diego Alvarez', 'Senior Barber', 'Diego is our fade specialist — precision skin fades and sharp line-ups are his signature. Award-winning at three regional barber competitions.', 'Skin Fades & Designs', 'https://i.pravatar.cc/300?img=12', 4.9, '{1,2,3,4,5,6}', 10, 20, 2),
('james-okafor', 'James Okafor', 'Barber & Colorist', 'James blends modern color technique with traditional barbering, known for natural grey-blending and creative color work.', 'Color & Modern Styles', 'https://i.pravatar.cc/300?img=14', 4.8, '{2,3,4,5,6,0}', 9, 18, 3),
('leo-fontaine', 'Leo Fontaine', 'Barber', 'Leo brings French-trained precision and a calm chairside manner, loved by clients for beard sculpting and kids'' cuts alike.', 'Beard Sculpting & Kids Cuts', 'https://i.pravatar.cc/300?img=15', 4.9, '{1,2,3,4,5}', 9, 17, 4);

insert into public.barber_services (id, name, description, price, duration, category, sort_order) values
('classic-haircut', 'Classic Haircut', 'Precision scissor and clipper cut, tailored to your style, finished with a hot towel neck shave.', 35, 30, 'Hair', 1),
('skin-fade', 'Signature Skin Fade', 'Razor-sharp fade blended seamlessly into your chosen style, finished with line-up detailing.', 45, 45, 'Hair', 2),
('beard-trim', 'Beard Sculpt & Trim', 'Shape, trim and define your beard with straight razor edging and beard oil finish.', 25, 30, 'Beard', 3),
('hot-towel-shave', 'Traditional Hot Towel Shave', 'A relaxing straight-razor shave with hot towel steaming, pre-shave oil and soothing balm.', 40, 45, 'Shave', 4),
('the-full-package', 'The Full Package', 'Haircut, beard sculpt, and hot towel shave combined — our most popular premium experience.', 85, 90, 'Combo', 5),
('kids-cut', 'Junior Cut (Under 12)', 'A patient, friendly cut for our youngest clients in a comfortable, fun environment.', 20, 30, 'Hair', 6),
('hair-color', 'Grey Blending & Color', 'Subtle grey blending or full color service using premium ammonia-free products.', 55, 60, 'Color', 7),
('vip-executive', 'VIP Executive Package', 'Haircut, shave, facial cleanse, scalp massage and styling — the ultimate grooming experience.', 120, 120, 'Combo', 8);

insert into public.barber_contacts (name, email, message, created_at) values
('Test User', 'test@example.com', 'Do you take walk-ins on weekends?', '2026-07-13T19:11:43.032Z');

insert into public.barber_bookings (id, service_id, service_name, base_price, price, duration, barber_id, barber_name, date, time, name, email, phone, notes, status, created_at) values
('60931c56-2729-41bc-a977-55895334bbb8', 'skin-fade', 'Signature Skin Fade', 45, 45, 45, 'diego-alvarez', 'Diego Alvarez', '2026-07-15', '11:00', 'Sameer Punk', 'sameer1punk@gmail.com', '(555) 987-6543', '', 'completed', '2026-07-13T19:09:53.307Z'),
('c5e39998-084d-44e4-ad41-adf3e4a63e13', 'classic-haircut', 'Classic Haircut', 35, 35, 30, 'diego-alvarez', 'Diego Alvarez', '2026-07-16', '10:00', 'Code BLAZE', 'sakchhamkarki1999@gmail.com', '9818527774', '', 'confirmed', '2026-07-13T19:50:35.613Z');
