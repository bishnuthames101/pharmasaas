/** Staff list row. Split out so the client row component can import the type
 *  without pulling a Server Component into the client bundle. */
export interface StaffMember {
  userId: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string;
}
