// server/questions.js
// Genel kültür soru bankası. Her soru: metin, 4 seçenek, doğru cevabın index'i,
// kategori ve zorluk seviyesi (easy | medium | hard) içerir.
// Zorluk arttıkça temel puan ve sabotaj sonrası seçilme ihtimali artar.

const QUESTIONS = [
  // ---------- TARİH ----------
  { category: 'Tarih', difficulty: 'easy', question: 'İstanbul\'un fethi hangi yıl gerçekleşmiştir?', options: ['1453', '1071', '1299', '1923'], correct: 0 },
  { category: 'Tarih', difficulty: 'easy', question: 'Türkiye Cumhuriyeti hangi yıl kurulmuştur?', options: ['1920', '1923', '1922', '1938'], correct: 1 },
  { category: 'Tarih', difficulty: 'easy', question: 'Malazgirt Meydan Muharebesi hangi yıl yapılmıştır?', options: ['1071', '1176', '1453', '1299'], correct: 0 },
  { category: 'Tarih', difficulty: 'medium', question: 'Osmanlı Devleti\'nin kurucusu kimdir?', options: ['II. Mehmet', 'Osman Bey', 'Orhan Bey', 'Yıldırım Bayezid'], correct: 1 },
  { category: 'Tarih', difficulty: 'medium', question: 'II. Dünya Savaşı hangi yıl sona ermiştir?', options: ['1943', '1945', '1939', '1950'], correct: 1 },
  { category: 'Tarih', difficulty: 'medium', question: 'Fransız İhtilali hangi yıl başlamıştır?', options: ['1789', '1804', '1776', '1815'], correct: 0 },
  { category: 'Tarih', difficulty: 'hard', question: 'Kanuni Sultan Süleyman\'ın tahta çıktığı yıl hangisidir?', options: ['1520', '1566', '1481', '1512'], correct: 0 },
  { category: 'Tarih', difficulty: 'hard', question: 'Berlin Duvarı hangi yıl yıkılmıştır?', options: ['1989', '1991', '1985', '1993'], correct: 0 },

  // ---------- COĞRAFYA ----------
  { category: 'Coğrafya', difficulty: 'easy', question: 'Dünyanın en büyük okyanusu hangisidir?', options: ['Atlas Okyanusu', 'Hint Okyanusu', 'Büyük Okyanus (Pasifik)', 'Arktik Okyanus'], correct: 2 },
  { category: 'Coğrafya', difficulty: 'easy', question: 'Türkiye\'nin başkenti neresidir?', options: ['İstanbul', 'İzmir', 'Ankara', 'Bursa'], correct: 2 },
  { category: 'Coğrafya', difficulty: 'easy', question: 'Dünyanın en uzun nehri hangisidir?', options: ['Amazon', 'Nil', 'Tuna', 'Mississippi'], correct: 1 },
  { category: 'Coğrafya', difficulty: 'medium', question: 'Everest Dağı hangi ülkeler sınırında yer alır?', options: ['Hindistan-Çin', 'Nepal-Çin', 'Pakistan-Hindistan', 'Nepal-Hindistan'], correct: 1 },
  { category: 'Coğrafya', difficulty: 'medium', question: 'Aşağıdakilerden hangisi bir ada ülkesi değildir?', options: ['Japonya', 'İzlanda', 'İsviçre', 'Sri Lanka'], correct: 2 },
  { category: 'Coğrafya', difficulty: 'hard', question: 'Dünyanın en derin okyanus çukuru hangisidir?', options: ['Mariana Çukuru', 'Puerto Rico Çukuru', 'Tonga Çukuru', 'Java Çukuru'], correct: 0 },
  { category: 'Coğrafya', difficulty: 'hard', question: 'Afrika kıtasının en yüksek dağı hangisidir?', options: ['Kilimanjaro', 'Kenya Dağı', 'Atlas Dağları', 'Ruwenzori'], correct: 0 },

  // ---------- BİLİM ----------
  { category: 'Bilim', difficulty: 'easy', question: 'Suyun kimyasal formülü nedir?', options: ['CO2', 'H2O', 'O2', 'NaCl'], correct: 1 },
  { category: 'Bilim', difficulty: 'easy', question: 'İnsan vücudunda en büyük organ hangisidir?', options: ['Karaciğer', 'Beyin', 'Deri', 'Akciğer'], correct: 2 },
  { category: 'Bilim', difficulty: 'easy', question: 'Güneş Sistemi\'ndeki en büyük gezegen hangisidir?', options: ['Dünya', 'Jüpiter', 'Satürn', 'Mars'], correct: 1 },
  { category: 'Bilim', difficulty: 'medium', question: 'Görelilik teorisini kim geliştirmiştir?', options: ['Isaac Newton', 'Albert Einstein', 'Stephen Hawking', 'Niels Bohr'], correct: 1 },
  { category: 'Bilim', difficulty: 'medium', question: 'DNA\'nın açılımı nedir?', options: ['Deoksiribo Nükleik Asit', 'Dinamik Nükleer Aktivite', 'Doğal Nöron Ağı', 'Değişken Nükleik Atom'], correct: 0 },
  { category: 'Bilim', difficulty: 'medium', question: 'Periyodik tabloda "Fe" hangi elementi simgeler?', options: ['Flor', 'Demir', 'Fosfor', 'Ferrit'], correct: 1 },
  { category: 'Bilim', difficulty: 'hard', question: 'Işık hızı yaklaşık olarak saniyede kaç kilometredir?', options: ['150.000 km', '300.000 km', '1.080.000 km', '30.000 km'], correct: 1 },
  { category: 'Bilim', difficulty: 'hard', question: 'Higgs bozonu ilk olarak hangi yıl deneysel olarak tespit edilmiştir?', options: ['2008', '2012', '2016', '2001'], correct: 1 },

  // ---------- SANAT & EDEBİYAT ----------
  { category: 'Sanat', difficulty: 'easy', question: 'Mona Lisa tablosunu kim yapmıştır?', options: ['Michelangelo', 'Leonardo da Vinci', 'Rafael', 'Van Gogh'], correct: 1 },
  { category: 'Sanat', difficulty: 'easy', question: '"Nutuk" adlı eserin yazarı kimdir?', options: ['Mustafa Kemal Atatürk', 'Namık Kemal', 'Yahya Kemal', 'Ziya Gökalp'], correct: 0 },
  { category: 'Sanat', difficulty: 'medium', question: 'Yıldız Savaşları filminin yönetmeni kimdir?', options: ['Steven Spielberg', 'George Lucas', 'James Cameron', 'Ridley Scott'], correct: 1 },
  { category: 'Sanat', difficulty: 'medium', question: '"Suç ve Ceza" romanının yazarı kimdir?', options: ['Lev Tolstoy', 'Anton Çehov', 'Fyodor Dostoyevski', 'Maksim Gorki'], correct: 2 },
  { category: 'Sanat', difficulty: 'hard', question: 'Sistine Şapeli tavan freskini kim yapmıştır?', options: ['Leonardo da Vinci', 'Michelangelo', 'Rafael', 'Donatello'], correct: 1 },

  // ---------- SPOR ----------
  { category: 'Spor', difficulty: 'easy', question: 'Bir futbol takımında kaleci hariç sahada kaç oyuncu bulunur?', options: ['9', '10', '11', '12'], correct: 1 },
  { category: 'Spor', difficulty: 'easy', question: 'Olimpiyat Oyunları kaç yılda bir düzenlenir?', options: ['2', '3', '4', '5'], correct: 2 },
  { category: 'Spor', difficulty: 'medium', question: '2014 FIFA Dünya Kupası\'nı hangi ülke kazanmıştır?', options: ['Brezilya', 'Almanya', 'Arjantin', 'İspanya'], correct: 1 },
  { category: 'Spor', difficulty: 'medium', question: 'Basketbolda bir maç normalde kaç periyottan oluşur?', options: ['2', '3', '4', '5'], correct: 2 },
  { category: 'Spor', difficulty: 'hard', question: 'Formula 1\'de en çok dünya şampiyonluğuna sahip pilot kimdir (2023 itibarıyla)?', options: ['Michael Schumacher', 'Lewis Hamilton', 'Ayrton Senna', 'Sebastian Vettel'], correct: 1 },

  // ---------- GENEL KÜLTÜR ----------
  { category: 'Genel Kültür', difficulty: 'easy', question: 'Bir yılda kaç mevsim vardır?', options: ['2', '3', '4', '5'], correct: 2 },
  { category: 'Genel Kültür', difficulty: 'easy', question: 'Türkiye\'nin para birimi nedir?', options: ['Euro', 'Dolar', 'Türk Lirası', 'Sterlin'], correct: 2 },
  { category: 'Genel Kültür', difficulty: 'easy', question: 'Bir düzine kaç adettir?', options: ['10', '12', '14', '20'], correct: 1 },
  { category: 'Genel Kültür', difficulty: 'medium', question: 'Dünya üzerinde en çok konuşulan ana dil hangisidir?', options: ['İngilizce', 'İspanyolca', 'Mandarin Çincesi', 'Hintçe'], correct: 2 },
  { category: 'Genel Kültür', difficulty: 'medium', question: 'Satrançta "at" taşı nasıl hareket eder?', options: ['Düz çizgide', 'Çapraz', 'L şeklinde', 'Herhangi bir yönde'], correct: 2 },
  { category: 'Genel Kültür', difficulty: 'medium', question: 'Dünyanın en küçük ülkesi hangisidir?', options: ['Monako', 'Vatikan', 'San Marino', 'Lihtenştayn'], correct: 1 },
  { category: 'Genel Kültür', difficulty: 'hard', question: 'Nobel Barış Ödülü hangi ülkede verilir?', options: ['İsveç', 'Norveç', 'İsviçre', 'Danimarka'], correct: 1 },
  { category: 'Genel Kültür', difficulty: 'hard', question: 'UNESCO\'nun merkezi hangi şehirdedir?', options: ['Cenevre', 'New York', 'Paris', 'Brüksel'], correct: 2 },
];

/**
 * Belirli bir zorluk seviyesine (veya "any") göre rastgele bir soru döndürür.
 * Aynı soru art arda tekrar etmesin diye excludeId (index) parametresi opsiyoneldir.
 */
function getRandomQuestion(difficulty = 'any', excludeIndex = -1) {
  let pool = QUESTIONS.map((q, i) => ({ ...q, _idx: i }));
  if (difficulty !== 'any') {
    const filtered = pool.filter(q => q.difficulty === difficulty);
    if (filtered.length > 0) pool = filtered;
  }
  if (pool.length > 1) {
    pool = pool.filter(q => q._idx !== excludeIndex);
  }
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return picked;
}

module.exports = { QUESTIONS, getRandomQuestion };
