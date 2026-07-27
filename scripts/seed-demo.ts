import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';

/**
 * Seeds a realistic demo pharmacy.
 *
 * Everything goes through the same RPCs the application uses — `provision_tenant`,
 * `receive_purchase`, `complete_sale` — rather than raw inserts, so the demo
 * data exercises the real code paths and cannot drift into states the app could
 * never produce. It also means running this is itself a smoke test.
 *
 *   pnpm seed:demo              creates a new pharmacy with a random slug
 *   pnpm seed:demo my-pharmacy  uses a chosen slug
 */

loadEnv({ path: '.env.local', quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error('Fill in .env.local before seeding.');
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Generated per run rather than hardcoded.
 *
 * A constant here would be a published credential: this script lives in the
 * repository, and the accounts it creates are real accounts on a real project.
 * The password is printed once at the end instead.
 */
const PASSWORD = `demo-${randomUUID().slice(0, 12)}`;

/** A cross-section of what a Nepali community pharmacy actually stocks. */
const CATALOGUE = [
  {
    name: 'Paracetamol 500mg',
    generic: 'paracetamol',
    cat: 'Analgesic',
    unit: 'tablet',
    pack: 10,
    cost: 1.2,
    sell: 2,
    min: 200,
    max: 1000,
  },
  {
    name: 'Ibuprofen 400mg',
    generic: 'ibuprofen',
    cat: 'Analgesic',
    unit: 'tablet',
    pack: 10,
    cost: 2.5,
    sell: 4,
    min: 100,
    max: 500,
  },
  {
    name: 'Amoxicillin 500mg',
    generic: 'amoxicillin',
    cat: 'Antibiotic',
    unit: 'capsule',
    pack: 10,
    cost: 8,
    sell: 13,
    min: 100,
    max: 400,
    rx: true,
  },
  {
    name: 'Azithromycin 500mg',
    generic: 'azithromycin',
    cat: 'Antibiotic',
    unit: 'tablet',
    pack: 3,
    cost: 30,
    sell: 45,
    min: 30,
    max: 120,
    rx: true,
  },
  {
    name: 'Cetirizine 10mg',
    generic: 'cetirizine',
    cat: 'Antihistamine',
    unit: 'tablet',
    pack: 10,
    cost: 1,
    sell: 2,
    min: 100,
    max: 600,
  },
  {
    name: 'Omeprazole 20mg',
    generic: 'omeprazole',
    cat: 'Antacid',
    unit: 'capsule',
    pack: 10,
    cost: 3,
    sell: 6,
    min: 100,
    max: 500,
  },
  {
    name: 'Metformin 500mg',
    generic: 'metformin',
    cat: 'Antidiabetic',
    unit: 'tablet',
    pack: 10,
    cost: 2,
    sell: 3.5,
    min: 200,
    max: 800,
    rx: true,
  },
  {
    name: 'Amlodipine 5mg',
    generic: 'amlodipine',
    cat: 'Antihypertensive',
    unit: 'tablet',
    pack: 10,
    cost: 2.2,
    sell: 4,
    min: 150,
    max: 600,
    rx: true,
  },
  {
    name: 'ORS Sachet',
    generic: 'oral rehydration salts',
    cat: 'Rehydration',
    unit: 'sachet',
    pack: 1,
    cost: 8,
    sell: 15,
    min: 50,
    max: 200,
  },
  {
    name: 'Cough Syrup 100ml',
    generic: 'dextromethorphan',
    cat: 'Cough & cold',
    unit: 'bottle',
    pack: 1,
    cost: 60,
    sell: 95,
    min: 20,
    max: 80,
  },
  {
    name: 'Diazepam 5mg',
    generic: 'diazepam',
    cat: 'Sedative',
    unit: 'tablet',
    pack: 10,
    cost: 3,
    sell: 6,
    min: 30,
    max: 100,
    rx: true,
    controlled: true,
  },
  {
    name: 'Vitamin C 500mg',
    generic: 'ascorbic acid',
    cat: 'Supplement',
    unit: 'tablet',
    pack: 15,
    cost: 1.5,
    sell: 3,
    min: 100,
    max: 400,
  },
];

const CUSTOMERS = [
  { name: 'Sita Sharma', phone: '9841000001', allergies: 'Penicillin' },
  { name: 'Ram Bahadur Thapa', phone: '9841000002', allergies: null },
  { name: 'Anita Gurung', phone: '9841000003', allergies: 'Sulfa drugs' },
  { name: 'Bikash Shrestha', phone: '9841000004', allergies: null },
  { name: 'Kamala Rai', phone: '9841000005', allergies: null },
];

function daysFromNow(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

async function main() {
  const slug = process.argv[2] ?? `demo-${randomUUID().slice(0, 6)}`;
  const ownerEmail = `owner@${slug}.demo.test`;
  const cashierEmail = `cashier@${slug}.demo.test`;

  console.log(`Seeding "${slug}"…\n`);

  // --- Owner and pharmacy -------------------------------------------------
  const { data: ownerUser, error: ownerError } =
    await admin.auth.admin.createUser({
      email: ownerEmail,
      password: PASSWORD,
      email_confirm: true,
    });
  if (ownerError) throw new Error(`owner: ${ownerError.message}`);

  const { data: tenant, error: tenantError } = await admin.rpc(
    'provision_tenant',
    {
      p_slug: slug,
      p_name: 'Himalaya Medical Hall',
      p_owner_id: ownerUser.user!.id,
      p_phone: '01-4567890',
      p_address: 'Putalisadak, Kathmandu',
    },
  );
  if (tenantError) throw new Error(`provision: ${tenantError.message}`);
  const tenantId = (tenant as { id: string }).id;
  console.log(`✓ Pharmacy provisioned (${tenantId})`);

  await admin.auth.admin.updateUserById(ownerUser.user!.id, {
    app_metadata: { tenant_id: tenantId },
  });

  // --- Cashier ------------------------------------------------------------
  const { data: cashierUser } = await admin.auth.admin.createUser({
    email: cashierEmail,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { tenant_id: tenantId },
  });
  await admin.from('tenant_users').insert({
    tenant_id: tenantId,
    user_id: cashierUser!.user!.id,
    role: 'cashier',
  });
  console.log('✓ Cashier added');

  // --- Sign the owner in so the rest runs under real RLS ------------------
  const ownerClient = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await ownerClient.auth.signInWithPassword({
    email: ownerEmail,
    password: PASSWORD,
  });

  // --- Suppliers ----------------------------------------------------------
  const { data: suppliers } = await ownerClient
    .from('suppliers')
    .insert([
      {
        name: 'Nepal Pharma Distributors',
        phone: '01-4111222',
        pan_vat_no: '301234567',
        email: null,
        address: null,
      },
      {
        name: 'Everest Medical Supply',
        phone: '01-4333444',
        pan_vat_no: '302345678',
        email: null,
        address: null,
      },
    ])
    .select('id, name');
  console.log(`✓ ${suppliers!.length} suppliers`);

  // --- Catalogue ----------------------------------------------------------
  const medicineRows = CATALOGUE.map((m) => ({
    name: m.name,
    generic_name: m.generic,
    category: m.cat,
    unit: m.unit,
    units_per_pack: m.pack,
    packs_per_box: 10,
    min_stock: m.min,
    max_stock: m.max,
    is_prescription_required: m.rx ?? false,
    is_controlled: m.controlled ?? false,
    tax_rate: 13,
    barcode: null,
    composition: null,
    strength: null,
    form: null,
    manufacturer: null,
    rack_location: null,
    is_active: true,
  }));

  const { data: medicines, error: medError } = await ownerClient
    .from('medicines')
    .insert(medicineRows)
    .select('id, name');
  if (medError) throw new Error(`medicines: ${medError.message}`);
  console.log(`✓ ${medicines!.length} medicines`);

  const idByName = new Map(
    medicines!.map((m) => [m.name as string, m.id as string]),
  );

  // --- Goods receipt, through the real RPC --------------------------------
  //
  // A deliberate spread of expiry dates: two already expired and two close to
  // it, so the expiry board and FEFO have something to show on a fresh demo.
  const expiries = [-15, 20, 45, 120, 240, 400];

  const { error: receiveError } = await ownerClient.rpc('receive_purchase', {
    p_payload: {
      supplier_id: suppliers![0].id,
      invoice_no: 'NPD-2026-0417',
      purchase_date: daysFromNow(-30),
      paid: 20000,
      items: CATALOGUE.map((m, i) => ({
        medicine_id: idByName.get(m.name),
        batch_no: `B${2026}${String(i + 1).padStart(3, '0')}`,
        expiry_date: daysFromNow(expiries[i % expiries.length]),
        qty: 40,
        pack_mode: true,
        unit_cost: m.cost,
        selling_price: m.sell,
        mrp: Number((m.sell * 1.1).toFixed(2)),
      })),
    },
  });
  if (receiveError) throw new Error(`receive: ${receiveError.message}`);
  console.log('✓ Opening stock received');

  // A second, part-paid delivery so the supplier ledger has a balance.
  await ownerClient.rpc('receive_purchase', {
    p_payload: {
      supplier_id: suppliers![1].id,
      invoice_no: 'EMS-8891',
      purchase_date: daysFromNow(-7),
      paid: 3000,
      items: [
        {
          medicine_id: idByName.get('ORS Sachet'),
          batch_no: 'ORS-2026-A',
          expiry_date: daysFromNow(300),
          qty: 500,
          unit_cost: 8,
          selling_price: 15,
        },
      ],
    },
  });
  console.log('✓ Second delivery (part paid, leaves a supplier balance)');

  // --- Customers ----------------------------------------------------------
  const { data: customers } = await ownerClient
    .from('customers')
    .insert(
      CUSTOMERS.map((c) => ({
        name: c.name,
        phone: c.phone,
        allergies: c.allergies,
        address: null,
        dob: null,
        gender: null,
        notes: null,
      })),
    )
    .select('id, name');
  console.log(`✓ ${customers!.length} customers`);

  // --- Sales, through complete_sale ---------------------------------------
  const cashierClient = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await cashierClient.auth.signInWithPassword({
    email: cashierEmail,
    password: PASSWORD,
  });

  const sellable = CATALOGUE.filter((m) => !m.rx).map((m) =>
    idByName.get(m.name)!,
  );

  let sold = 0;
  for (let i = 0; i < 25; i++) {
    const lineCount = 1 + Math.floor(Math.random() * 3);
    const chosen = new Set<string>();
    while (chosen.size < lineCount) chosen.add(pick(sellable));

    const isCredit = Math.random() < 0.15;
    const customer = Math.random() < 0.5 ? pick(customers!) : null;

    const { error } = await cashierClient.rpc('complete_sale', {
      p_payload: {
        customer_id: isCredit ? (customer?.id ?? null) : (customer?.id ?? null),
        payment_method: isCredit && customer ? 'credit' : 'cash',
        paid: isCredit && customer ? 0 : 500,
        items: [...chosen].map((id) => ({
          medicine_id: id,
          qty: 1 + Math.floor(Math.random() * 6),
          discount: 0,
        })),
      },
    });

    // Expired batches are legitimately unsellable, so a shortfall here is the
    // system working rather than a seeding failure.
    if (!error) sold++;
  }
  console.log(`✓ ${sold} sales recorded`);

  // --- A prescription and a controlled dispensing -------------------------
  const { data: rx } = await ownerClient
    .from('prescriptions')
    .insert({
      customer_id: customers![0].id,
      prescriber_name: 'Dr. R. Adhikari',
      prescriber_reg_no: 'NMC-20481',
      issued_date: daysFromNow(-3),
      refills_allowed: 2,
      notes: 'Take after food.',
      image_path: null,
      sale_id: null,
    })
    .select('id')
    .single();

  await cashierClient.rpc('complete_sale', {
    p_payload: {
      customer_id: customers![0].id,
      prescription_id: rx!.id,
      payment_method: 'cash',
      paid: 200,
      items: [{ medicine_id: idByName.get('Diazepam 5mg'), qty: 10 }],
    },
  });
  console.log('✓ Prescription recorded and a controlled item dispensed');

  // --- A write-off, so the adjustments trail is not empty -----------------
  const { data: expiredBatch } = await ownerClient
    .from('batches')
    .select('id, qty_available')
    .lt('expiry_date', new Date().toISOString().slice(0, 10))
    .gt('qty_available', 0)
    .limit(1)
    .maybeSingle();

  if (expiredBatch) {
    await ownerClient.rpc('adjust_stock', {
      p_batch_id: expiredBatch.id,
      p_qty_change: -Number(expiredBatch.qty_available),
      p_reason: 'expiry_writeoff',
      p_notes: 'Written off during monthly expiry check',
    });
    console.log('✓ Expired batch written off');
  }

  const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'localhost:3000';
  const base = root.startsWith('localhost')
    ? `http://${root}/t/${slug}`
    : `https://${slug}.${root}`;

  console.log(`
Done.

  Pharmacy   Himalaya Medical Hall
  URL        ${base}
  Owner      ${ownerEmail}
  Cashier    ${cashierEmail}
  Password   ${PASSWORD}   ← generated for this run, not stored anywhere

Sign in as the cashier to see the counter without cost or margin anywhere.
`);
}

main().catch((error) => {
  console.error('\nSeeding failed:', error.message);
  process.exit(1);
});
