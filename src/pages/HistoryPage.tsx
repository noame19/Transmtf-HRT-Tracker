import React from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAppData } from '../contexts/AppDataContext';
import { DoseEvent } from '../../logic';
import HistoryView from '../views/HistoryView';

interface OutletContext {
    onAddEvent: () => void;
    onEditEvent: (event: DoseEvent) => void;
    onBatchAdd: () => void;
}

const HistoryPage: React.FC = () => {
    const { onAddEvent, onEditEvent, onBatchAdd } = useOutletContext<OutletContext>();
    const { events } = useAppData();

    return (
        <HistoryView
            events={events}
            onAddEvent={onAddEvent}
            onEditEvent={onEditEvent}
            onBatchAdd={onBatchAdd}
        />
    );
};

export default HistoryPage;
