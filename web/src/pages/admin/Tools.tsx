import { DatabaseZap } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardHeader, PageHeader } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export function AdminTools() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Tools" />
      <Card className="max-w-2xl">
        <CardHeader title={<span className="flex items-center gap-2"><DatabaseZap className="size-4" />Upgrade bookings from the old site</span>} />
        <div className="space-y-4 p-5 text-sm text-ink-600 dark:text-ink-300">
          <p>Bookings created by the old website store dates as text. The new app already reads them, but upgrading them adds proper timestamps so they appear in reminders, automatic completion and every report. The old fields are kept. Safe to run more than once.</p>
          <Button loading={busy} onClick={async () => {
            setBusy(true);
            try {
              const res = await api.migrateLegacyBookings({});
              setResult(`Upgraded ${res.migrated} booking${res.migrated === 1 ? '' : 's'}${res.skipped ? `; ${res.skipped} could not be read and were left as they are` : ''}.`);
              toast.success('Migration complete');
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}>Upgrade legacy bookings</Button>
          {result && <p className="rounded-xl bg-emerald-50 p-3 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">{result}</p>}
        </div>
      </Card>
    </>
  );
}
