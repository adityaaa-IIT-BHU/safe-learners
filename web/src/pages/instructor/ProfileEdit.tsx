import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { Camera, CarFront, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { fullName, type Transmission, type VehicleDetails } from '@shared/domain';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Button, Card, CardHeader, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { usePrivateProfile } from '@/lib/data';
import { db } from '@/lib/firebase';
import { uploadFile } from '@/lib/upload';

export function ProfileEdit() {
  const me = useProfile();
  const { readOnly } = useAuth();
  const [form, setForm] = useState({
    firstName: me.firstName ?? '',
    surname: me.surname ?? '',
    mobile: me.mobile ?? '',
    bio: me.bio ?? '',
    languages: me.languages ?? '',
    startYear: me.startYear ?? '',
    transmission: (me.transmission ?? 'Auto') as Transmission,
  });
  const [vehicle, setVehicle] = useState<VehicleDetails>(() => ({ ...me.vehicle, ancap: me.vehicle?.ancap ?? '5 Star', dualControls: me.vehicle?.dualControls ?? true }));
  const { data: priv } = usePrivateProfile(me.id);
  useEffect(() => { if (priv?.mobile) setForm(f => ({ ...f, mobile: f.mobile || priv.mobile })); }, [priv?.mobile]);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<'photo' | 'vehicle' | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const vehicleInput = useRef<HTMLInputElement>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  const setV = (k: keyof VehicleDetails) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setVehicle(v => ({ ...v, [k]: e.target.value }));

  const upload = async (kind: 'photo' | 'vehicle', file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error('Please choose an image file.');
    setUploading(kind);
    try {
      const url = await uploadFile(`photos/${me.id}/${kind}-${Date.now()}.jpg`, file);
      if (kind === 'photo') await updateDoc(doc(db, 'users', me.id), { photoUrl: url });
      else {
        setVehicle(v => ({ ...v, photoUrl: url }));
        await updateDoc(doc(db, 'users', me.id), { vehicle: { ...vehicle, photoUrl: url } });
      }
      toast.success(kind === 'photo' ? 'Profile photo updated' : 'Vehicle photo updated');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(null);
    }
  };

  const save = async () => {
    if (!form.firstName.trim()) return toast.error('First name is required.');
    setSaving(true);
    try {
      const cleanVehicle = Object.fromEntries(Object.entries(vehicle).filter(([, v]) => v !== '' && v !== undefined));
      const { mobile, ...publicFields } = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
      // Your mobile is private: it's only given to learners in their booking details.
      await setDoc(doc(db, 'users', me.id, 'private', 'profile'), { mobile }, { merge: true });
      await updateDoc(doc(db, 'users', me.id), {
        ...publicFields,
        vehicle: { ...cleanVehicle, dualControls: vehicle.dualControls === true || (vehicle.dualControls as unknown) === 'true' },
      });
      toast.success('Profile saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Profile & vehicle" subtitle="This is what learners see before they book you."
        actions={<>
          <Link to={`/instructors/${me.id}`} target="_blank" className="inline-flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800"><ExternalLink className="size-4" />View public profile</Link>
          <Button onClick={save} loading={saving} disabled={readOnly}>Save changes</Button>
        </>} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="About you" />
          <div className="space-y-4 p-5">
            {/* Large portrait, like the vehicle photo — this is what learners see first */}
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-end">
              <button
                type="button"
                onClick={() => photoInput.current?.click()}
                disabled={readOnly}
                className="group relative aspect-[4/5] w-44 shrink-0 overflow-hidden rounded-3xl border-2 border-dashed border-ink-200 bg-ink-50 dark:border-ink-700 dark:bg-ink-800/50"
                aria-label="Change profile photo"
              >
                {me.photoUrl
                  ? <img src={me.photoUrl} alt={fullName(me)} className="size-full object-cover object-top" />
                  : <span className="flex size-full flex-col items-center justify-center gap-2 text-sm text-ink-500"><Camera className="size-6" />Add a photo</span>}
                {me.photoUrl && <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-ink-950/60 py-2 text-xs font-semibold text-white opacity-0 transition group-hover:opacity-100"><Camera className="size-3.5" />Change photo</span>}
                {uploading === 'photo' && <span className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-semibold dark:bg-ink-900/70">Uploading…</span>}
              </button>
              <div className="text-center sm:text-left">
                <Button variant="secondary" size="sm" icon={<Camera className="size-4" />} loading={uploading === 'photo'} disabled={readOnly} onClick={() => photoInput.current?.click()}>{me.photoUrl ? 'Change photo' : 'Upload photo'}</Button>
                <p className="mt-2 max-w-xs text-xs text-ink-500">A friendly, clear head-and-shoulders photo builds trust. Shown large on your public profile.</p>
                <input ref={photoInput} type="file" accept="image/*" hidden onChange={e => upload('photo', e.target.files?.[0])} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="First name" value={form.firstName} onChange={set('firstName')} />
              <Input label="Surname" value={form.surname} onChange={set('surname')} />
              <Input label="Mobile" type="tel" value={form.mobile} onChange={set('mobile')} hint="Private — only shown to learners in their booking details." />
              <Input label="Teaching since" type="number" min={1970} max={new Date().getFullYear()} placeholder="e.g. 2015" value={form.startYear} onChange={set('startYear')} />
              <Select label="Transmission" value={form.transmission} onChange={set('transmission')}>
                <option value="Auto">Automatic</option>
                <option value="Manual">Manual</option>
                <option value="Auto & Manual">Automatic & manual</option>
              </Select>
              <Input label="Languages" placeholder="e.g. English, Hindi" value={form.languages} onChange={set('languages')} />
            </div>
            <Textarea label="Bio" rows={6} maxLength={1500} value={form.bio} onChange={set('bio')} placeholder="Your teaching style, experience, and what learners can expect." hint={`${form.bio.length}/1500`} />
          </div>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><CarFront className="size-4" />Lesson vehicle</span>} />
          <div className="space-y-4 p-5">
            <button type="button" onClick={() => vehicleInput.current?.click()} disabled={readOnly} className="group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-ink-200 bg-ink-50 dark:border-ink-700 dark:bg-ink-800/50">
              {vehicle.photoUrl ? <img src={vehicle.photoUrl} alt="Vehicle" className="size-full object-cover" /> : <span className="flex flex-col items-center gap-2 text-sm text-ink-500"><Camera className="size-6" />Add a photo of your car</span>}
              {uploading === 'vehicle' && <span className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-semibold dark:bg-ink-900/70">Uploading…</span>}
            </button>
            <input ref={vehicleInput} type="file" accept="image/*" hidden onChange={e => upload('vehicle', e.target.files?.[0])} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Make" placeholder="e.g. Toyota" value={vehicle.make ?? ''} onChange={setV('make')} />
              <Input label="Model" placeholder="e.g. Corolla Hybrid" value={vehicle.model ?? ''} onChange={setV('model')} />
              <Input label="Year" placeholder="e.g. 2022" value={vehicle.year ?? ''} onChange={setV('year')} />
              <Input label="Colour" placeholder="e.g. White" value={vehicle.colour ?? ''} onChange={setV('colour')} hint="Helps learners spot you at pick up." />
              <Input label="Number plate" placeholder="e.g. AB12CD" value={vehicle.plateNumber ?? ''} onChange={setV('plateNumber')} />
              <Select label="ANCAP safety rating" value={vehicle.ancap ?? '5 Star'} onChange={setV('ancap')}>
                <option>5 Star</option><option>4 Star</option><option>3 Star</option><option>Other/Not Rated</option>
              </Select>
              <Select label="Dual controls" value={String(vehicle.dualControls ?? true)} onChange={e => setVehicle(v => ({ ...v, dualControls: e.target.value === 'true' }))} wrapperClassName="sm:col-span-2">
                <option value="true">Yes — fitted with dual controls</option>
                <option value="false">No</option>
              </Select>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
