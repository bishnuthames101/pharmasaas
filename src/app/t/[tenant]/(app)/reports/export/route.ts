import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';

/**
 * CSV export.
 *
 * Reads through the caller's session, so the same RLS that governs the screen
 * governs the file: a cashier gets a 403 here, and a pharmacist exporting the
 * profit report gets their permitted rows and nothing else. There is no
 * service-role shortcut anywhere in this path.
 */

/** RFC 4180 quoting: wrap in quotes and double any quote inside. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
  ];
  // CRLF and a BOM, so Excel opens it correctly — which is where these files
  // actually get used.
  return '﻿' + lines.join('\r\n');
}

/**
 * Fields are typed as plain strings rather than literals on purpose:
 * supabase-js derives a row type per view-and-column-list combination, and
 * letting five of them form a union produces "expression produces a union type
 * that is too complex to represent". The rows are serialised straight to CSV,
 * so nothing downstream needs the precise shape.
 */
interface ReportDefinition {
  view: string;
  columns: string;
  dateColumn: string | null;
  ownerOnly: boolean;
}

const REPORTS: Record<string, ReportDefinition> = {
  daily: {
    view: 'sales_daily',
    columns:
      'day, sale_count, subtotal, discount, tax, total, cash_total, credit_total',
    dateColumn: 'day',
    ownerOnly: false,
  },
  profit: {
    view: 'sale_profit',
    columns:
      'sale_date, medicine_name, category, qty_net, unit_price, cost_price, revenue, cost, profit',
    dateColumn: 'sale_date',
    ownerOnly: true,
  },
  valuation: {
    view: 'stock_valuation',
    columns:
      'medicine_name, category, unit, qty_on_hand, qty_saleable, cost_value, retail_value',
    dateColumn: null,
    ownerOnly: false,
  },
  movement: {
    view: 'medicine_movement',
    columns:
      'name, category, unit, qty_sold_90d, revenue_90d, qty_on_hand, days_of_cover',
    dateColumn: null,
    ownerOnly: false,
  },
  controlled: {
    view: 'controlled_register',
    columns:
      'created_at, medicine_name, strength, qty, unit, customer_name, customer_phone, prescriber_name, prescriber_reg_no, invoice_no',
    dateColumn: 'created_at',
    ownerOnly: false,
  },
};

export async function GET(
  request: Request,
  context: RouteContext<'/t/[tenant]/reports/export'>,
) {
  const { tenant: slug } = await context.params;
  const access = await getTenantAccess(slug);

  if (!access.ok) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 403 });
  }
  if (access.role === 'cashier') {
    return NextResponse.json({ error: 'Not authorised' }, { status: 403 });
  }

  const url = new URL(request.url);
  const name = url.searchParams.get('report') ?? 'daily';
  const report = REPORTS[name];

  if (!report) {
    return NextResponse.json({ error: 'Unknown report' }, { status: 400 });
  }
  if (report.ownerOnly && access.role !== 'owner') {
    return NextResponse.json({ error: 'Owner only' }, { status: 403 });
  }

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const supabase = await createClient();
  let builder = supabase.from(report.view).select(report.columns);

  if (report.dateColumn && from) {
    builder = builder.gte(report.dateColumn, from);
  }
  if (report.dateColumn && to) {
    // Date columns take the bare date; timestamps need the end of that day.
    builder = builder.lte(
      report.dateColumn,
      report.dateColumn === 'day' ? to : `${to}T23:59:59`,
    );
  }

  const { data, error } = await builder;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Double cast: with a runtime column string, supabase-js cannot infer a row
  // type and falls back to its error shape. The rows are only ever stringified
  // into CSV, so a plain record is the honest description of what we have.
  const csv = toCsv((data ?? []) as unknown as Record<string, unknown>[]);
  const filename = `${slug}-${name}-${from ?? 'all'}-to-${to ?? 'now'}.csv`;

  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // Financial data: never let a shared cache hold on to it.
      'cache-control': 'no-store',
    },
  });
}
