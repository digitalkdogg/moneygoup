import { loginLimiter } from '@/utils/rateLimiter';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createLogger } from '@/utils/logger';
import type { NextAuthOptions } from 'next-auth';

const logger = createLogger('auth');

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        if (!credentials?.username || !credentials.password) {
          logger.warn('Authorization attempt with missing credentials.');
          return null;
        }

        // Rate limit login attempts by IP
        const ip = (req?.headers as any)?.['x-forwarded-for']?.split(',')[0].trim()
          ?? (req?.headers as any)?.['x-real-ip']
          ?? 'unknown';
        const { allowed } = loginLimiter.check(ip);

        if (!allowed) {
          // Returning null tells NextAuth "credentials invalid" without leaking rate limit info
          // to the client via the error message. The 429 is not surfaced directly here.
          logger.warn('Login rate limit exceeded', { ip });
          return null;
        }

        try {
          const [rows] = await executeRawQuery(
            'SELECT id, username, password_hash, role FROM users WHERE username = ?',
            [credentials.username]
          );

          const user =
            Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

          if (!user) {
            logger.warn('Authorization attempt with unknown username:', {
              username: credentials.username,
            });
            return null;
          }

          const isPasswordValid = await bcrypt.compare(
            credentials.password,
            user.password_hash
          );

          if (!isPasswordValid) {
            logger.warn('Authorization attempt with invalid password for user:', {
              username: credentials.username,
            });
            return null;
          }

          logger.info('User authorized successfully:', {
            userId: user.id,
            username: credentials.username,
            });

            // Update last_login asynchronously - don't block the login response
            executeRawQuery(
            'UPDATE users SET last_login = NOW() WHERE id = ?',
            [user.id]
            ).catch((err) => {
            logger.error('Failed to update last_login for user:', {
              userId: user.id,
              error: err instanceof Error ? err : String(err),
            });
            });

            return {
            id: user.id.toString(),

            name: user.username,
            role: user.role || 'user',
          };
        } catch (error: unknown) {
          logger.error(
            'Database error during authorization:',
            { error: error instanceof Error ? error : String(error) }
          );
          return null;
        }
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: process.env.SESSION_MAX_AGE ? (parseInt(process.env.SESSION_MAX_AGE) || 30 * 24 * 60 * 60) : 30 * 24 * 60 * 60,
  },
  cookies: {
    sessionToken: {
      name: 'next-auth.session-token',
      options: {
        httpOnly: true,
        secure: process.env.NEXTAUTH_URL?.startsWith('https') ?? false,
        sameSite: 'lax',
        path: '/',
        maxAge: process.env.SESSION_MAX_AGE ? (parseInt(process.env.SESSION_MAX_AGE) || 30 * 24 * 60 * 60) : 30 * 24 * 60 * 60,
      },
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.name = user.name;
        token.role = (user as any).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as any).role = token.role as string;
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
};

