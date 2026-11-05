import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';

export function NotFound() {
  return (
    <div className="page">
      <PageHeader title="Page not found" />
      <EmptyState icon={<Compass />} title="We couldn’t find that page" action={<Link to="/dashboard" className="btn btn-primary">Go to the dashboard</Link>}>
        The address may be mistyped, or the page may have moved.
      </EmptyState>
    </div>
  );
}
