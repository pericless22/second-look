// 30 SYNTHETIC test messages (EN + KO). All names, numbers, accounts and links are fabricated
// for testing only. Phone numbers use reserved/fictional ranges (555-01xx, 010-0000-xxxx).
export interface Sample { id: string; lang: 'en' | 'ko'; expected: 'scam' | 'suspicious' | 'safe'; label: string; text: string; }

export const SAMPLES: Sample[] = [
  // ---------- English ----------
  { id: 'en01', lang: 'en', expected: 'scam', label: 'Delivery fee (USPS lookalike)', text: 'USPS: Your package is on hold due to an incomplete address. Pay the $1.99 redelivery fee within 24h: http://usps-redelivery-fee.top/track?id=88213' },
  { id: 'en02', lang: 'en', expected: 'scam', label: '"Hi Mom" new number', text: "Hi Mom, it's me. I dropped my phone and this is my new number. Can you send $450 to my friend's account 1029384756 for a bill? Please don't tell Dad, I'll explain later." },
  { id: 'en03', lang: 'en', expected: 'scam', label: 'Bank account suspended', text: 'ALERT: Your Chase account has been suspended due to unusual activity. Verify your identity immediately at https://chase-secure-login.xyz or call (415) 555-0134.' },
  { id: 'en04', lang: 'en', expected: 'scam', label: 'IRS refund', text: 'IRS NOTICE: You are eligible for a tax refund of $1,280.50. Submit your SSN and bank details to claim before it expires: bit.ly/irs-refund-2026' },
  { id: 'en05', lang: 'en', expected: 'scam', label: 'Crypto investment', text: 'Hey! Our private investment group guarantees 30% weekly returns on crypto. Double your money in 2 weeks. Join now, only 3 spots left: t.ly/cryptogain' },
  { id: 'en06', lang: 'en', expected: 'scam', label: 'Gift card from "boss"', text: "This is Mark from the office. I'm in a meeting and need you to buy 5 Apple gift cards ($100 each) for a client urgently. Send me the codes. Keep this between us for now." },
  { id: 'en07', lang: 'en', expected: 'scam', label: 'Netflix payment failed', text: 'Netflix: Your payment was declined. Update your card details within 12 hours to avoid suspension: http://netflix-billing-update.online' },
  { id: 'en08', lang: 'en', expected: 'scam', label: 'Job offer easy money', text: 'Remote job offer! Like YouTube videos and earn $300 per day. Work from home, no experience. Message our recruiter on WhatsApp +1 555 0199 2231 to start today.' },
  { id: 'en09', lang: 'en', expected: 'scam', label: 'Tech support remote access', text: 'Microsoft Security: Your PC is infected with 3 viruses. Call support now at 1-555-0142-889 and install AnyDesk so our technician can fix it remotely.' },
  { id: 'en10', lang: 'en', expected: 'scam', label: 'Prize winner', text: 'Congratulations! You are the winner of our Amazon loyalty prize: a new iPhone 18. Pay $4.95 shipping to claim: amazon-rewards-claim.click' },
  { id: 'en11', lang: 'en', expected: 'scam', label: 'Verification code forwarding', text: "Hey, I accidentally sent my verification code to your number. Could you forward me the 6-digit code you just received? Thanks!" },
  { id: 'en12', lang: 'en', expected: 'suspicious', label: 'Wrong number romance opener', text: "Hi Jessica, is this still your number? It's David from the golf club. Oh sorry, wrong number! You seem nice though, where are you from?" },
  { id: 'en13', lang: 'en', expected: 'safe', label: 'Family dinner', text: "Hi mom, running 10 min late, save me some dinner! See you at 7." },
  { id: 'en14', lang: 'en', expected: 'safe', label: 'Pharmacy ready', text: 'Your prescription is ready for pickup at the pharmacy on Main St. Reply STOP to opt out.' },
  { id: 'en15', lang: 'en', expected: 'safe', label: 'Official login code', text: 'Your Google verification code is 482913. Do not share this code with anyone.' },
  // ---------- Korean ----------
  { id: 'ko01', lang: 'ko', expected: 'scam', label: '택배 주소지 불명', text: '[CJ대한통운] 고객님 택배가 주소지 불명으로 보관중입니다. 주소 수정 후 재배송 신청 바랍니다 → http://cj-delivery-check.xyz/kr' },
  { id: 'ko02', lang: 'ko', expected: 'scam', label: '자녀 사칭 (액정 파손)', text: '엄마 나 폰 액정이 깨져서 수리 맡겼어. 이 번호로 문자해. 급하게 결제할 게 있는데 엄마 신분증 사진이랑 카드 앞뒤 사진 좀 보내줘. 아빠한텐 말하지 마.' },
  { id: 'ko03', lang: 'ko', expected: 'scam', label: '검찰 사칭', text: '[서울중앙지검] 귀하의 명의가 금융범죄에 도용되어 수사 중입니다. 자산 보호를 위해 오늘 중 안전계좌 110-000-123456 으로 이체하고 담당 수사관 010-0000-1234 로 연락 바랍니다.' },
  { id: 'ko04', lang: 'ko', expected: 'scam', label: '건강보험 환급금', text: '[국민건강보험] 미환급금 284,000원이 확인되었습니다. 본인인증 후 즉시 환급 가능: han.gl/nhis2026 (주민번호 900101-1000000 입력 필요)' },
  { id: 'ko05', lang: 'ko', expected: 'scam', label: '저금리 대환대출', text: '[KB국민] 고객님은 정부지원 저금리 대환대출 대상자입니다. 한도조회는 전용 앱 설치 후 가능합니다. 상담: 1588-0000 / kb-loan-gov.site' },
  { id: 'ko06', lang: 'ko', expected: 'scam', label: '주식 리딩방', text: '안녕하세요 회원님, VIP 리딩방 무료 체험 안내드립니다. 원금보장 월 수익 300% 급등주 정보 제공! 지금 입장하세요 → me2.do/vipstock' },
  { id: 'ko07', lang: 'ko', expected: 'scam', label: '부고 문자 링크', text: '[부고] 故 김OO님께서 별세하셨기에 삼가 알려드립니다. 장례식장 안내: http://bugo-notice.click/view?n=2931' },
  { id: 'ko08', lang: 'ko', expected: 'scam', label: '해외 결제 승인', text: '[Web발신] 해외결제 승인 1,280,000원 (아마존). 본인 결제가 아닐 경우 고객센터 02-0000-1234 로 즉시 신고 바랍니다.' },
  { id: 'ko09', lang: 'ko', expected: 'scam', label: '청첩장 링크', text: '저희 결혼합니다♡ 바쁘시더라도 꼭 와주세요. 모바일 청첩장 확인하기 → vo.la/wedding77' },
  { id: 'ko10', lang: 'ko', expected: 'scam', label: '고액 재택 알바', text: '재택 부업 모집! 하루 1시간 일당 15만원 보장. 상품 리뷰만 작성하면 됩니다. 카톡 ID: easymoney77 로 문의주세요.' },
  { id: 'ko11', lang: 'ko', expected: 'suspicious', label: '중고거래 외부 결제', text: '안녕하세요 물건 아직 있나요? 제가 지방이라 직거래는 어렵고 안전결제 링크 보내드릴게요. 계좌 1002-345-678901 로 먼저 입금해주시면 바로 발송할게요.' },
  { id: 'ko12', lang: 'ko', expected: 'suspicious', label: '지인 사칭 송금 부탁', text: '선배님 저 민수예요. 급하게 200만원만 빌려주실 수 있을까요? 내일 바로 갚을게요. 제 계좌 말고 동생 계좌 3333-00-1234567 로 부탁드려요.' },
  { id: 'ko13', lang: 'ko', expected: 'safe', label: '가족 일상', text: '엄마 오늘 저녁 7시쯤 도착해요. 김치찌개 해주세요 ㅎㅎ' },
  { id: 'ko14', lang: 'ko', expected: 'safe', label: '병원 예약 안내', text: '[OO내과] 11월 20일(금) 오전 10시 진료 예약되었습니다. 변경은 진료일 전날까지 전화로 부탁드립니다.' },
  { id: 'ko15', lang: 'ko', expected: 'safe', label: '공식 인증번호', text: '[네이버] 인증번호 [482913]을 입력해주세요. 타인에게 절대 알려주지 마세요.' },
];
