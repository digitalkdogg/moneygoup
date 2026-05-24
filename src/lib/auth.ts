import { loginLimiter } from '@/utils/rateLimiter';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createLogger } from '@/utils/logger';
import type { NextAuthOptions } from 'next-auth';
import { evaluateApprovalStatus } from '@/utils/approvalStatus';

const logger = createLogger('auth');

const SESSION_MAX_AGE_SECS = process.env.SESSION_MAX_AGE
  ? (parseInt(process.env.SESSION_MAX_AGE) || 30 * 24 * 60 * 60)
  : 30 * 24 * 60 * 60;

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
          logger.warn('Login rate limit exceeded', { ip });
          return null;
        }

        try {
          const [rows] = await executeRawQuery(
            'SELECT id, username, password_hash, role, approval_status, rejected_reason FROM users WHERE username = ?',
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

          // Check approval status
          const approvalOutcome = evaluateApprovalStatus(user.approval_status, user.rejected_reason);
          if (!approvalOutcome.allowed) {
            logger.warn('Authorization denied due to approval status:', {
              userId: user.id,
              username: credentials.username,
              status: user.approval_status,
              code: approvalOutcome.code
            });
            // Throwing an error with the code so the frontend can handle it
            throw new Error(approvalOutcome.code);
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
            approvalStatus: user.approval_status || 'pending'
          };
        } catch (error: unknown) {
          if (error instanceof Error && (error.message === 'ACCOUNT_PENDING_APPROVAL' || error.message === 'ACCOUNT_REJECTED')) {
            throw error;
          }
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
    maxAge: SESSION_MAX_AGE_SECS,
  },
  cookies: {
    sessionToken: {
      name: `${process.env.NEXTAUTH_URL?.startsWith('https://') ? '__Secure-' : ''}next-auth.session-token`,
      options: {
        httpOnly: true,
        secure: process.env.NEXTAUTH_URL?.startsWith('https://') || false,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_SECS,
      },
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.name = user.name;
        token.role = user.role;
        token.approvalStatus = user.approvalStatus;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.role = token.role;
        session.user.approvalStatus = token.approvalStatus;
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
};

