import NextAuth, { DefaultSession } from 'next-auth';
import type { UserRole, ApprovalStatus } from '@/types/auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      approvalStatus: ApprovalStatus;
    } & DefaultSession['user'];
  }

  interface User {
    id: string;
    role: UserRole;
    approvalStatus: ApprovalStatus;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    role: UserRole;
    approvalStatus: ApprovalStatus;
  }
}

