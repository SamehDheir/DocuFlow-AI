import type { Metadata } from 'next';
import { RegisterForm } from './register-form';

export const metadata: Metadata = {
  title: 'Create your workspace',
  description: 'Set up a DocuFlow AI workspace for your company.',
};

export default function RegisterPage() {
  return <RegisterForm />;
}
