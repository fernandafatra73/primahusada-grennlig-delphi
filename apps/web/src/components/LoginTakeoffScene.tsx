/** Ilustrasi dekoratif halaman login: pesawat Prima Husada lepas landas dari kiri ke kanan. */
export function LoginTakeoffScene() {
  return (
    <figure className="login-scene" aria-hidden>
      <svg className="login-scene__svg" viewBox="0 0 360 140" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="login-scene-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5b9bd5" />
            <stop offset="100%" stopColor="#d6e9f8" />
          </linearGradient>
          <linearGradient id="login-scene-tail" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0b2a6f" />
            <stop offset="100%" stopColor="#1f5fbf" />
          </linearGradient>
        </defs>

        {/* Langit */}
        <rect x="0" y="0" width="360" height="140" fill="url(#login-scene-sky)" />
        <circle cx="318" cy="24" r="11" fill="#fff4c2" />

        <g className="login-scene__clouds" fill="#ffffff" opacity="0.9">
          <g transform="translate(40 26)">
            <ellipse cx="0" cy="0" rx="16" ry="6" />
            <ellipse cx="10" cy="-4" rx="10" ry="6" />
          </g>
          <g transform="translate(170 16)">
            <ellipse cx="0" cy="0" rx="20" ry="6" />
            <ellipse cx="-8" cy="-4" rx="10" ry="6" />
          </g>
          <g transform="translate(260 50)">
            <ellipse cx="0" cy="0" rx="14" ry="5" />
            <ellipse cx="7" cy="-3" rx="8" ry="5" />
          </g>
        </g>

        {/* Bukit & tanah */}
        <path d="M0 104 Q60 88 120 102 T240 98 T360 100 V140 H0 Z" fill="#8fbf7a" />
        <rect x="0" y="108" width="360" height="32" fill="#6fa35a" />

        {/* Landasan pacu memanjang kiri → kanan */}
        <rect x="0" y="112" width="360" height="18" fill="#3b3f45" />
        <rect x="0" y="112" width="360" height="1.2" fill="#e8e8e8" />
        <rect x="0" y="128.8" width="360" height="1.2" fill="#e8e8e8" />
        <g fill="#f5f5f5">
          {[4, 8, 12, 16, 20].map((x) => (
            <rect key={`thr-${x}`} x={x} y="114.5" width="2" height="13" />
          ))}
        </g>
        <g fill="#f5f5f5">
          {Array.from({ length: 13 }, (_, i) => 30 + i * 26).map((x) => (
            <rect key={`ctr-${x}`} x={x} y="120.4" width="14" height="1.2" />
          ))}
        </g>
        <g className="login-scene__lights" fill="#ffd166">
          {Array.from({ length: 12 }, (_, i) => 12 + i * 30).map((x) => (
            <circle key={`lgt-${x}`} cx={x} cy="132.5" r="1.1" />
          ))}
        </g>

        {/* Bayangan pesawat di landasan */}
        <ellipse className="login-scene__shadow" cx="0" cy="124" rx="26" ry="2.2" fill="#000000" opacity="0.3" />

        {/* Pesawat: titik (0,0) = roda utama, hidung menghadap kanan */}
        <g className="login-scene__plane">
          <g transform="translate(0 -3)">
            {/* Sayap belakang (sisi jauh) */}
            <path d="M-6 -9 L-20 -16 L-14 -16 L4 -9 Z" fill="#9aa9c4" />
            {/* Ekor tegak */}
            <path d="M-34 -10 L-42 -28 L-34 -28 L-22 -11 Z" fill="url(#login-scene-tail)" />
            <text x="-36" y="-17" fontSize="5.5" fontWeight="700" fill="#ffffff" fontFamily="Arial, sans-serif">
              PH
            </text>
            {/* Badan pesawat */}
            <path
              d="M-40 -9 Q-40 -14 -30 -14 L22 -14 Q34 -14 40 -8 Q36 -3 26 -3 L-30 -3 Q-38 -3 -40 -9 Z"
              fill="#ffffff"
              stroke="#0b2a6f"
              strokeWidth="0.6"
            />
            {/* Garis livery */}
            <path d="M-38 -6.2 L33 -6.2 L35.5 -5 L-37 -5 Z" fill="#0b2a6f" />
            {/* Jendela kokpit */}
            <path d="M31 -11.5 L36 -8.8 L31.5 -8.8 Z" fill="#1d3557" />
            {/* Jendela kabin */}
            <g fill="#1d3557">
              {Array.from({ length: 9 }, (_, i) => -22 + i * 5.5).map((x) => (
                <rect key={`win-${x}`} x={x} y="-12.2" width="2.2" height="1.6" rx="0.5" />
              ))}
            </g>
            <text
              x="-19"
              y="-7.4"
              fontSize="3.6"
              fontWeight="700"
              fill="#0b2a6f"
              fontFamily="Arial, sans-serif"
              letterSpacing="0.3"
            >
              PRIMA HUSADA
            </text>
            {/* Sayap depan & mesin */}
            <path d="M-8 -6 L-22 4 L-15 4 L6 -6 Z" fill="#c7d2e6" stroke="#0b2a6f" strokeWidth="0.4" />
            <rect x="-6" y="-3.6" width="9" height="3.4" rx="1.6" fill="#0b2a6f" />
            {/* Roda */}
            <g className="login-scene__gear" fill="#222222">
              <rect x="-0.4" y="-3" width="0.8" height="1.6" />
              <circle cx="0" cy="1.2" r="1.8" />
              <rect x="25.6" y="-3" width="0.8" height="1.6" />
              <circle cx="26" cy="1.2" r="1.5" />
            </g>
          </g>
        </g>
      </svg>
    </figure>
  );
}
