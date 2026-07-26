import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

interface CustomSelectProps {
    value: string;
    onChange: (val: string) => void;
    options: { value: string; label: string; icon?: React.ReactNode }[];
    label?: string;
}

const CustomSelect = ({ value, onChange, options, label }: CustomSelectProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const [focusedIndex, setFocusedIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const listboxRef = useRef<HTMLDivElement>(null);
    // Stable unique ID for ARIA relationships
    const idRef = useRef(`cs-${Math.random().toString(36).slice(2, 8)}`);
    const listboxId = `${idRef.current}-listbox`;
    const labelId = label ? `${idRef.current}-label` : undefined;

    const selectedIndex = options.findIndex(o => o.value === value);
    const selectedOption = options[selectedIndex];

    // Close on outside click. The listbox lives in document.body via portal,
    // so `containerRef` (the trigger wrapper) alone isn't enough — a click on
    // the listbox itself wouldn't be "inside" containerRef. Treat both as
    // "inside this select" and close on anything else.
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node;
            const inTrigger = containerRef.current?.contains(target);
            const inListbox = listboxRef.current?.contains(target);
            if (!inTrigger && !inListbox) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    // Move DOM focus to the focused option whenever focusedIndex changes while open
    useEffect(() => {
        if (!isOpen || !listboxRef.current) return;
        const items = listboxRef.current.querySelectorAll<HTMLElement>('[role="option"]');
        items[focusedIndex]?.focus();
    }, [isOpen, focusedIndex]);

    /**
     * Position the listbox directly under the trigger using `position: fixed`
     * coords from `getBoundingClientRect()`. Re-runs on every window scroll
     * and resize so the panel follows the button even when a parent
     * scroll-container (modal body) scrolls. Capture phase catches scrolls
     * inside any ancestor — `position: fixed` only tracks viewport, not
     * nested scroll containers.
     *
     * The trigger lives inside modals whose `modal-spring-glass` animation
     * leaves a residual `transform: ...` on the modal card. Per CSS spec,
     * any ancestor with a transform makes that ancestor the containing
     * block for `position: absolute` descendants, which is why the old
     * `absolute top-full` listbox drifted out of the modal. `position:
     * fixed` uses the viewport as its containing block regardless of
     * ancestor transforms — that's why we portal + fix.
     */
    useLayoutEffect(() => {
        if (!isOpen) return;
        const positionListbox = () => {
            if (!buttonRef.current || !listboxRef.current) return;
            const rect = buttonRef.current.getBoundingClientRect();
            const el = listboxRef.current;
            el.style.position = 'fixed';
            el.style.top = `${rect.bottom + 8}px`;
            el.style.left = `${rect.left}px`;
            el.style.width = `${rect.width}px`;
            // Clamp to viewport: if the listbox would overflow the bottom,
            // flip it above the trigger instead of clipping off-screen.
            const listboxHeight = el.offsetHeight;
            const overflow = rect.bottom + 8 + listboxHeight - window.innerHeight;
            if (overflow > 0 && rect.top - 8 - listboxHeight > 0) {
                el.style.top = `${rect.top - 8 - listboxHeight}px`;
            }
        };
        // Initial paint + on any scroll (capture phase catches nested scroll
        // containers that the trigger might sit inside) or resize.
        positionListbox();
        window.addEventListener('resize', positionListbox);
        window.addEventListener('scroll', positionListbox, true);
        return () => {
            window.removeEventListener('resize', positionListbox);
            window.removeEventListener('scroll', positionListbox, true);
        };
    }, [isOpen, options.length]);

    const openList = (initialIndex?: number) => {
        const idx = initialIndex ?? (selectedIndex >= 0 ? selectedIndex : 0);
        setFocusedIndex(idx);
        setIsOpen(true);
    };

    const closeList = () => {
        setIsOpen(false);
        buttonRef.current?.focus();
    };

    const selectOption = (val: string) => {
        onChange(val);
        closeList();
    };

    const handleButtonKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case 'Enter':
            case ' ':
            case 'ArrowDown':
                e.preventDefault();
                openList();
                break;
            case 'ArrowUp':
                e.preventDefault();
                openList(options.length - 1);
                break;
        }
    };

    const handleOptionKeyDown = (e: React.KeyboardEvent, index: number) => {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setFocusedIndex(Math.min(index + 1, options.length - 1));
                break;
            case 'ArrowUp':
                e.preventDefault();
                setFocusedIndex(Math.max(index - 1, 0));
                break;
            case 'Home':
                e.preventDefault();
                setFocusedIndex(0);
                break;
            case 'End':
                e.preventDefault();
                setFocusedIndex(options.length - 1);
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                selectOption(options[index].value);
                break;
            case 'Escape':
            case 'Tab':
                e.preventDefault();
                closeList();
                break;
        }
    };

    return (
        <div className="space-y-2" ref={containerRef}>
            {label && (
                <label id={labelId} className="block text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>
                    {label}
                </label>
            )}
            <button
                ref={buttonRef}
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                aria-controls={listboxId}
                aria-labelledby={labelId}
                onClick={() => isOpen ? closeList() : openList()}
                onKeyDown={handleButtonKeyDown}
                className="w-full p-4 rounded-xl outline-none flex items-center justify-between transition-all glass-input"
                onFocus={e => e.currentTarget.style.boxShadow = '0 0 0 2px var(--glass-input-focus-ring)'}
                onBlur={e => e.currentTarget.style.boxShadow = 'none'}
            >
                <div className="flex items-center gap-2">
                    {selectedOption?.icon}
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{selectedOption?.label || value}</span>
                </div>
                <ChevronDown size={20} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--text-tertiary)' }} />
            </button>

            {/* Listbox is rendered into <body> via portal so it escapes the
                modal card's residual `transform` (left behind by the
                `modal-spring-glass` animation), which would otherwise make
                the modal card the containing block and drag the old
                `position: absolute` panel out of place. `position: fixed` is
                set imperatively in useLayoutEffect — top/left/width come from
                buttonRef.getBoundingClientRect() and stay in sync with
                window scroll + resize so the panel keeps following the
                trigger even when a parent scroll-container (modal body)
                scrolls. */}
            {isOpen && typeof document !== 'undefined' && createPortal(
                <div
                    ref={listboxRef}
                    id={listboxId}
                    role="listbox"
                    aria-labelledby={labelId}
                    style={{ zIndex: 9999 }}
                    className="rounded-xl max-h-60 overflow-y-auto animate-in fade-in zoom-in-95 duration-100 glass-heavy glass-noise"
                >
                    {options.map((opt, index) => (
                        <div
                            key={opt.value}
                            role="option"
                            aria-selected={opt.value === value}
                            tabIndex={focusedIndex === index ? 0 : -1}
                            onClick={() => selectOption(opt.value)}
                            onKeyDown={(e) => handleOptionKeyDown(e, index)}
                            onMouseEnter={() => setFocusedIndex(index)}
                            className={`w-full p-3 text-left flex items-center gap-2 cursor-pointer transition-colors outline-none
                                focus:ring-2 focus:ring-inset
                                ${opt.value === value ? 'font-bold' : 'hover:bg-[var(--bg-soft-rose)]'}`}
                            style={{
                                color: opt.value === value ? 'var(--accent-500)' : 'var(--text-primary)',
                                background: opt.value === value ? 'var(--bg-soft-rose)' : undefined,
                            }}
                        >
                            {opt.icon}
                            <span>{opt.label}</span>
                            {opt.value === value && <div className="ml-auto w-2 h-2 rounded-full" style={{ background: 'var(--accent-400)' }} aria-hidden="true" />}
                        </div>
                    ))}
                </div>,
                document.body,
            )}
        </div>
    );
};

export default CustomSelect;
