import { AccountForm } from "@/components/account-form";

export const metadata = { title: "Your account" };

export default function AccountPage() {
  return <section className="library-page account-page"><AccountForm /></section>;
}
