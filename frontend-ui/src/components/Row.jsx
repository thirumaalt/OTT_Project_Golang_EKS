import React, { useRef, useState } from "react";
import MediaCard from "./MediaCard";

export default function Row({ title, items, onInfo, onPlay }) {
    const rowRef = useRef(null);
    const [isMoved, setIsMoved] = useState(false);

    const handleClick = (direction) => {
        setIsMoved(true);
        if (rowRef.current) {
            const { scrollLeft, clientWidth } = rowRef.current;
            const scrollTo = direction === "left"
                ? scrollLeft - clientWidth
                : scrollLeft + clientWidth;

            rowRef.current.scrollTo({ left: scrollTo, behavior: "smooth" });
        }
    };

    if (!items || items.length === 0) return null;

    return (
        <div className="space-y-2 md:space-y-4 mb-8">
            <h2 className="w-56 cursor-pointer text-sm font-semibold text-[#e5e5e5] transition duration-200 hover:text-white md:text-2xl pl-4 md:pl-12">
                {title}
            </h2>

            <div className="group relative md:-ml-2">
                <button
                    className={`absolute top-0 bottom-0 left-2 z-40 m-auto h-full w-9 cursor-pointer opacity-0 transition hover:scale-125 group-hover:opacity-100 ${!isMoved && "hidden"}`}
                    onClick={() => handleClick("left")}
                >
                    <svg className="h-9 w-9 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                </button>

                <div
                    ref={rowRef}
                    className="flex items-center space-x-2.5 overflow-x-scroll scrollbar-hide md:space-x-4 md:p-2 pl-4 md:pl-12"
                >
                    {items.map((item) => (
                        <div key={item.id} className="relative h-28 min-w-[180px] cursor-pointer transition duration-200 ease-out md:h-36 md:min-w-[260px] md:hover:scale-105">
                            <MediaCard item={item} onInfo={onInfo} onPlay={onPlay} />
                        </div>
                    ))}
                </div>

                <button
                    className="absolute top-0 bottom-0 right-2 z-40 m-auto h-full w-9 cursor-pointer opacity-0 transition hover:scale-125 group-hover:opacity-100"
                    onClick={() => handleClick("right")}
                >
                    <svg className="h-9 w-9 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
            </div>
        </div>
    );
}
