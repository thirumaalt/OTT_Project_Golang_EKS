import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";

export default function PlansPage() {
    const { user } = useAuth();
    const [loading, setLoading] = useState(false);

    const plans = [
        { id: "BASIC", name: "Basic", price: 0, features: ["720p Streaming", "1 Device", "Ads"] },
        { id: "STANDARD", name: "Standard", price: 199, features: ["1080p Streaming", "2 Devices", "No Ads"] },
        { id: "PREMIUM", name: "Premium", price: 499, features: ["4K HDR Streaming", "4 Devices", "No Ads", "Offline Downloads"] },
    ];

    const loadRazorpay = () =>
        new Promise((resolve) => {
            if (window.Razorpay) { resolve(true); return; }
            const script = document.createElement("script");
            script.src = "https://checkout.razorpay.com/v1/checkout.js";
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.body.appendChild(script);
        });

    const handleSubscribe = async (plan) => {
        if (plan.price === 0) {
            alert("You are now on the Free plan!");
            return;
        }

        setLoading(true);
        try {
            // 1. Create Order
            const order = await api(`/payment/create-order?amount=${plan.price}`, { method: "POST" });

            // Mock order — bypass Razorpay entirely
            if (!order.razorpayOrderId || order.razorpayOrderId.startsWith("order_mock_")) {
                console.log("Mock Order detected, bypassing Razorpay...");
                await new Promise(r => setTimeout(r, 1000));
                await api(`/payment/capture-payment?orderId=${order.razorpayOrderId}`, { method: "POST" });
                await api(`/subscription/upgrade?userId=${user.id}&plan=${plan.id}`, { method: "POST" });
                alert(`✅ Success! You are now subscribed to ${plan.name} (Demo Mode)`);
                return;
            }

            // 2. Load Razorpay SDK dynamically
            const sdkLoaded = await loadRazorpay();
            if (!sdkLoaded || !window.Razorpay) {
                // Razorpay unavailable — simulate payment in demo mode
                await api(`/payment/capture-payment?orderId=${order.razorpayOrderId}`, { method: "POST" });
                await api(`/subscription/upgrade?userId=${user.id}&plan=${plan.id}`, { method: "POST" });
                alert(`✅ Success! You are now subscribed to ${plan.name} (Demo Mode)`);
                return;
            }

            // 3. Open Razorpay checkout
            const rzpKey = import.meta.env.VITE_RAZORPAY_KEY_ID || "";
            const options = {
                key: rzpKey,
                amount: order.amount,
                currency: order.currency || "INR",
                name: "MyFlix",
                description: `Subscribe to ${plan.name}`,
                order_id: order.razorpayOrderId,
                handler: async function (response) {
                    await api(`/payment/capture-payment?orderId=${order.razorpayOrderId}`, { method: "POST" });
                    await api(`/subscription/upgrade?userId=${user.id}&plan=${plan.id}`, { method: "POST" });
                    alert(`✅ Success! You are now subscribed to ${plan.name}`);
                },
                prefill: {
                    email: user.email,
                },
                theme: { color: "#E50914" },
            };

            const rzp = new window.Razorpay(options);
            rzp.open();

        } catch (e) {
            console.error("Payment failed", e);
            alert("Payment failed. Please try again.");
        } finally {
            setLoading(false);
        }
    };


    return (
        <div className="min-h-screen pt-24 px-4 md:px-12 bg-black text-white">
            <h1 className="text-4xl font-bold text-center mb-4">Choose Your Plan</h1>
            <p className="text-gray-400 text-center mb-12">Cancel anytime. No commitments.</p>

            <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
                {plans.map((plan) => (
                    <div key={plan.id} className={`p-8 rounded-xl border ${plan.id === "PREMIUM" ? "border-red-600 bg-red-900/10" : "border-gray-800 bg-gray-900"}`}>
                        <h2 className="text-2xl font-bold mb-2">{plan.name}</h2>
                        <div className="text-3xl font-bold mb-6">
                            {plan.price === 0 ? "Free" : `₹${plan.price}`}
                            <span className="text-sm font-normal text-gray-400">/month</span>
                        </div>

                        <ul className="space-y-4 mb-8">
                            {plan.features.map((f, i) => (
                                <li key={i} className="flex items-center gap-2 text-gray-300">
                                    <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                    {f}
                                </li>
                            ))}
                        </ul>

                        <button
                            onClick={() => handleSubscribe(plan)}
                            disabled={loading}
                            className={`w-full py-3 rounded font-bold transition ${plan.id === "PREMIUM"
                                    ? "bg-red-600 hover:bg-red-700 text-white"
                                    : "bg-white text-black hover:bg-gray-200"
                                }`}
                        >
                            {loading ? "Processing..." : "Subscribe"}
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
