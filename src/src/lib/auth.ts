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
      async authorize(credentials) {
        if (!credentials?.username || !credentials.password) {
          logger.warn('Authorization attempt with missing credentials.');
          return null;
        }

        try {
          const [rows] = await executeRawQuery(
            'SELECT id, username, password_hash FROM users WHERE username = ?',
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
            username: user.username,
          });

          return {
            id: user.id.toString(),
            name: user.username,
          };
        } catch (error: unknown) {
          logger.error(
            'Database error during authorization:',
            error instanceof Error ? error : String(error)
          );
          return null;
        }
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60,
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
};

