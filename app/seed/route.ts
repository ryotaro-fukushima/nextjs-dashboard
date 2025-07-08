import bcrypt from 'bcrypt';
import postgres from 'postgres';
import { invoices, customers, revenue, users } from '../lib/placeholder-data';

// データベース接続の設定を最適化
const sql = postgres(process.env.POSTGRES_URL!, { 
  ssl: { rejectUnauthorized: false }, // Supabase用のSSL設定
  max: 1, // 接続プールサイズを1に制限
  idle_timeout: 30, // アイドルタイムアウトを30秒に設定
  connect_timeout: 60, // 接続タイムアウトを60秒に設定
  connection: {
    application_name: 'nextjs-dashboard-seed', // アプリケーション名を設定
  },
  onnotice: () => {}, // 通知を無視
  onparameter: () => {}, // パラメータ変更を無視
  transform: {
    // 接続をより安定させるための設定
    undefined: null,
  },
});

// タイムアウト付きのPromiseを作成するヘルパー関数
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

// リトライ機能付きの接続テスト
async function testConnection(maxRetries = 3): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`Connection attempt ${i + 1}/${maxRetries}...`);
      // より軽量なクエリで接続テスト
      await withTimeout(sql`SELECT 1 as test`, 15000);
      console.log('Database connection successful');
      return;
    } catch (error) {
      console.error(`Connection attempt ${i + 1} failed:`, error);
      if (i === maxRetries - 1) {
        throw error;
      }
      console.log('Retrying in 3 seconds...');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

async function seedUsers() {
  console.log('  - Creating uuid-ossp extension...');
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
  
  console.log('  - Creating users table...');
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    );
  `;

  console.log('  - Hashing passwords...');
  // パスワードハッシュ化を並列処理で実行
  const hashedPasswords = await Promise.all(
    users.map(user => bcrypt.hash(user.password, 10))
  );

  console.log('  - Inserting users into database...');
  const insertedUsers = await Promise.all(
    users.map(async (user, index) => {
      return sql`
        INSERT INTO users (id, name, email, password)
        VALUES (${user.id}, ${user.name}, ${user.email}, ${hashedPasswords[index]})
        ON CONFLICT (id) DO NOTHING;
      `;
    }),
  );

  console.log('  - Users seeding completed');
  return insertedUsers;
}

async function seedInvoices() {
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;

  await sql`
    CREATE TABLE IF NOT EXISTS invoices (
      id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
      customer_id UUID NOT NULL,
      amount INT NOT NULL,
      status VARCHAR(255) NOT NULL,
      date DATE NOT NULL
    );
  `;

  const insertedInvoices = await Promise.all(
    invoices.map(
      (invoice) => sql`
        INSERT INTO invoices (customer_id, amount, status, date)
        VALUES (${invoice.customer_id}, ${invoice.amount}, ${invoice.status}, ${invoice.date})
        ON CONFLICT (id) DO NOTHING;
      `,
    ),
  );

  return insertedInvoices;
}

async function seedCustomers() {
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;

  await sql`
    CREATE TABLE IF NOT EXISTS customers (
      id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      image_url VARCHAR(255) NOT NULL
    );
  `;

  const insertedCustomers = await Promise.all(
    customers.map(
      (customer) => sql`
        INSERT INTO customers (id, name, email, image_url)
        VALUES (${customer.id}, ${customer.name}, ${customer.email}, ${customer.image_url})
        ON CONFLICT (id) DO NOTHING;
      `,
    ),
  );

  return insertedCustomers;
}

async function seedRevenue() {
  await sql`
    CREATE TABLE IF NOT EXISTS revenue (
      month VARCHAR(4) NOT NULL UNIQUE,
      revenue INT NOT NULL
    );
  `;

  const insertedRevenue = await Promise.all(
    revenue.map(
      (rev) => sql`
        INSERT INTO revenue (month, revenue)
        VALUES (${rev.month}, ${rev.revenue})
        ON CONFLICT (month) DO NOTHING;
      `,
    ),
  );

  return insertedRevenue;
}

export async function GET() {
  try {
    console.log('Starting database seeding...');
    
    // 環境変数の確認
    if (!process.env.POSTGRES_URL) {
      console.error('POSTGRES_URL environment variable is not set');
      return new Response(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Environment Variable Error</title>
            <style>
              body { font-family: Arial, sans-serif; padding: 20px; }
              .success { color: green; }
              .error { color: red; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Environment Variable Error</h1>
            <p>POSTGRES_URL environment variable is not set</p>
            <p><a href="/dashboard">Go to Dashboard</a></p>
          </body>
        </html>
      `, {
        status: 500,
        headers: {
          'Content-Type': 'text/html',
        },
      });
    }
    
    console.log('POSTGRES_URL is set:', process.env.POSTGRES_URL.substring(0, 20) + '...');
    
    // データベース接続テスト
    console.log('Testing database connection...');
    try {
      await testConnection(); // リトライ機能付きの接続テスト
    } catch (connError) {
      console.error('Database connection failed:', connError);
      return new Response(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Database Connection Error</title>
            <style>
              body { font-family: Arial, sans-serif; padding: 20px; }
              .success { color: green; }
              .error { color: red; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Database Connection Failed</h1>
            <p>Error: ${connError instanceof Error ? connError.message : 'Unknown connection error'}</p>
            <p><a href="/dashboard">Go to Dashboard</a></p>
          </body>
        </html>
      `, {
        status: 500,
        headers: {
          'Content-Type': 'text/html',
        },
      });
    }
    
    const result = await sql.begin(async (sql) => {
      console.log('Creating users...');
      const usersResult = await seedUsers();
      
      console.log('Creating customers...');
      const customersResult = await seedCustomers();
      
      console.log('Creating invoices...');
      const invoicesResult = await seedInvoices();
      
      console.log('Creating revenue...');
      const revenueResult = await seedRevenue();
      
      return { usersResult, customersResult, invoicesResult, revenueResult };
    });

    console.log('Database seeded successfully');
    return new Response(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Database Seeded Successfully</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            .success { color: green; }
            .error { color: red; }
          </style>
        </head>
        <body>
          <h1 class="success">✅ Database Seeded Successfully!</h1>
          <p>All tables and data have been created successfully.</p>
          <p><a href="/dashboard">Go to Dashboard</a></p>
        </body>
      </html>
    `, {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  } catch (error) {
    console.error('Error seeding database:', error);
    return new Response(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Database Seeding Error</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            .success { color: green; }
            .error { color: red; }
          </style>
        </head>
        <body>
          <h1 class="error">❌ Database Seeding Failed</h1>
          <p>Error: ${error instanceof Error ? error.message : 'Unknown error'}</p>
          <p><a href="/dashboard">Go to Dashboard</a></p>
        </body>
      </html>
    `, {
      status: 500,
      headers: {
        'Content-Type': 'text/html',
      },
    });
  } finally {
    // データベース接続を閉じる
    await sql.end();
  }
}
