// Small shared rules of the invoice and refund documents -- Feature 6015.
//
// Invoicing / Home and business customers: a billed-to is a business (2) when it has a
// business name, else a home (1). Foundations / Brand identity: the number on every
// "Questions about this bill / refund?" line is the accounts phone, or the operator phone
// while that is blank.
import type { BilledTo } from "./issue.js";

export function isBusinessBilledTo(billedTo: Pick<BilledTo, "businessName">): boolean {
  return billedTo.businessName !== undefined && billedTo.businessName.trim() !== "";
}

export function billQuestionsPhone(settings: { operatorPhone: string; accountsPhone: string | null }): string {
  const accounts = settings.accountsPhone?.trim() ?? "";
  return accounts !== "" ? accounts : settings.operatorPhone;
}
