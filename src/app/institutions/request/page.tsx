import type { Metadata } from 'next';
import { InstitutionRequestForm } from '@/components/InstitutionRequestForm';
import { OnboardingCard } from '@/components/OnboardingCard';

export const metadata: Metadata = { title: 'Request an institution · PotentialPaper' };

export default function RequestInstitution() {
  return (
    <OnboardingCard title="Request an institution">
      <InstitutionRequestForm />
    </OnboardingCard>
  );
}
