import React, { useState } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useAppData } from '../contexts/AppDataContext';
import { nextGelProductId } from '../utils/doseForm';
import {
    type GelForm, EMPTY_GEL_FORM, productToForm, validateGelForm, gelFormsEqual,
} from '../utils/gelForm';
import { Route, ExtraKey, type GelProductSpec } from '../../logic';
import { FlaskConical, Plus, Pencil, Trash2 } from 'lucide-react';

const CustomGelManager: React.FC = () => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const { events, gelProducts, setGelProducts } = useAppData();

    const refCountOf = (id: number) =>
        events.filter(e => e.route === Route.gel && e.extras?.[ExtraKey.gelProductId] === id).length;

    // null = closed; -1 = adding new; >=1000 = editing that product id
    const [editingId, setEditingId] = useState<number | null>(null);
    const [form, setForm] = useState<GelForm>(EMPTY_GEL_FORM);
    // The product being edited, kept verbatim so an untouched "edit + save"
    // round-trips to the exact stored spec instead of re-deriving (and slightly
    // changing) its kinetics from the lossy bio%/half-life form fields.
    const [editingOriginal, setEditingOriginal] = useState<GelProductSpec | null>(null);

    const openAdd = () => { setForm(EMPTY_GEL_FORM); setEditingOriginal(null); setEditingId(-1); };
    const openEdit = (p: GelProductSpec) => { setForm(productToForm(p)); setEditingOriginal(p); setEditingId(p.id); };
    const close = () => { setEditingId(null); setEditingOriginal(null); setForm(EMPTY_GEL_FORM); };

    const save = () => {
        // Editing without changing any field → keep the original spec untouched.
        if (editingId !== null && editingId !== -1 && editingOriginal && gelFormsEqual(form, productToForm(editingOriginal))) {
            close();
            return;
        }
        const id = editingId === -1 ? nextGelProductId(gelProducts) : (editingId ?? -1);
        const result = validateGelForm(form, id);
        if ('error' in result) { showDialog('alert', t(result.error)); return; }
        if (editingId === -1) {
            setGelProducts([...gelProducts, result.product]);
        } else if (editingId !== null) {
            setGelProducts(gelProducts.map(p => (p.id === editingId ? result.product : p)));
        }
        close();
    };

    const remove = (p: GelProductSpec) => {
        const refs = refCountOf(p.id);
        const msg = refs > 0
            ? `${t('gel.custom.delete_confirm')}（${refs} ${t('sync.conflict.items')}）`
            : t('gel.custom.delete_confirm');
        showDialog('confirm', msg, () => {
            setGelProducts(gelProducts.filter(q => q.id !== p.id));
            if (editingId === p.id) close();
        });
    };

    const field = (key: keyof GelForm, label: string, opts?: { text?: boolean }) => (
        <label className="text-xs block" style={{ color: 'var(--text-tertiary)' }}>
            {label}
            <input
                value={form[key]}
                onChange={e => setForm({ ...form, [key]: e.target.value })}
                inputMode={opts?.text ? undefined : 'decimal'}
                className="w-full mt-1 p-2 rounded-lg glass-input outline-none"
                style={{ color: 'var(--text-primary)' }}
            />
        </label>
    );

    return (
        <div className="rounded-2xl glass-card p-4 space-y-3">
            <div className="flex items-start gap-3">
                <FlaskConical size={20} style={{ color: 'var(--accent-500)' }} />
                <div>
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.gel.title')}</p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('settings.gel.desc')}</p>
                </div>
            </div>

            {/* Existing custom products */}
            {gelProducts.length > 0 && (
                <div className="space-y-2">
                    {gelProducts.map(p => (
                        <div key={p.id} className="flex items-center gap-2 p-3 rounded-xl" style={{ background: 'var(--bg-card-hover)' }}>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>{p.name || `#${p.id}`}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    {p.concentrationMGmL} mg/g · {p.defaultAreaCM2} cm² · F≈{Math.round((p.kPenBase / (p.kPenBase + p.kLoss)) * 100)}%
                                </p>
                            </div>
                            <button type="button" onClick={() => openEdit(p)} className="p-2 rounded-lg" style={{ color: 'var(--text-secondary)' }} aria-label={t('btn.edit')}>
                                <Pencil size={16} />
                            </button>
                            <button type="button" onClick={() => remove(p)} className="p-2 rounded-lg text-red-500" aria-label={t('btn.delete')}>
                                <Trash2 size={16} />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Add / edit form */}
            {editingId !== null ? (
                <div className="p-3 space-y-2 rounded-xl border" style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)' }}>
                    {field('name', t('gel.custom.name'), { text: true })}
                    <div className="grid grid-cols-2 gap-2">
                        {field('conc', t('gel.custom.conc'))}
                        {field('area', t('gel.custom.area'))}
                        {field('bio', t('gel.custom.bio'))}
                        {field('halflife', t('gel.custom.halflife'))}
                    </div>
                    <div className="flex gap-2 pt-1">
                        <button type="button" onClick={save} className="flex-1 py-2 text-sm font-bold rounded-lg" style={{ background: 'var(--accent-500)', color: '#fff' }}>{t('btn.save')}</button>
                        <button type="button" onClick={close} className="flex-1 py-2 text-sm font-bold rounded-lg" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
                    </div>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={openAdd}
                    className="flex w-full items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold btn-press-glass"
                    style={{ background: 'var(--bg-card-hover)', color: 'var(--accent-500)' }}
                >
                    <Plus size={18} />
                    {t('gel.custom.add')}
                </button>
            )}
        </div>
    );
};

export default CustomGelManager;
