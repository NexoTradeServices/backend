// The current contractor agreement -- Feature 2006.
//
// The current version is the latest issued. One read, used by every place
// that decides readiness, so the ops list and record, Bob's dashboard and the
// dispatch guard all agree.
import type { Prisma } from "../generated/prisma/client.js";

type Reader = Pick<Prisma.TransactionClient, "contractorAgreementVersion">;

export async function currentAgreement(client: Reader) {
  return client.contractorAgreementVersion.findFirst({ orderBy: [{ issuedAt: "desc" }, { id: "desc" }] });
}

/** The label readiness compares against; null while nothing has been published. */
export async function currentAgreementLabel(client: Reader): Promise<string | null> {
  return (await currentAgreement(client))?.version ?? null;
}
