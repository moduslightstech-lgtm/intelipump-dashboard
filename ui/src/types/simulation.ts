export interface SimState {
    tank: {
        id: string;
        label: string;
        capacity: number;
        currentLiters: number;
        percent: number;
        startLiters: number;
    };
    pumps: {
        id: string;
        label: string;
        transactions: number;
        totalLiters: number;
        status: 'IDLE' | 'DISPENSING';
        currentDispenseRate: number;
    }[];
}
